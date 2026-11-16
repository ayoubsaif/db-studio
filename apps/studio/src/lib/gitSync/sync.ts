import * as fs from 'fs'
import * as path from 'path'
import { classify } from './classify'
import { hashQuery, parseQueryFile, QueryFile, renderQueryFile, safeFileName } from './format'
import { branchInfo, BranchInfo, commitPath, fetch, GitError, pullFastForward, push as gitPush, repoRoot } from './git'
import { SyncState } from './state'

export interface SyncConfig {
  /** a folder inside a git working tree */
  repoPath: string
  /** folder holding the .sql files, relative to repoPath; empty means repoPath itself */
  subdir: string
}

/** Where saved queries live in the app. Implemented over the database in the handlers. */
export interface QueryStore {
  list(): Promise<QueryFile[]>
  create(query: QueryFile): Promise<void>
  update(title: string, changes: { text: string, database: string | null }): Promise<void>
}

export interface Conflict {
  title: string
  local: { text: string, database: string | null }
  repo: { text: string, database: string | null }
}

export interface PullResult {
  fastForwarded: boolean
  created: string[]
  updated: string[]
  conflicts: Conflict[]
  warnings: string[]
}

export interface PushResult {
  written: string[]
  /** changed in the repository since the last sync; pull to receive them */
  needPull: string[]
  conflicts: Conflict[]
  committed: boolean
  pushed: boolean
  warnings: string[]
}

export type Choice = 'local' | 'repo' | 'both'

export interface Resolution {
  title: string
  choice: Choice
}

export interface SyncStatus extends BranchInfo {
  root: string
  /** queries that differ between the app and the repository files */
  pendingPush: number
  pendingPull: number
  conflicts: number
}

interface RepoFile {
  file: string
  query: QueryFile
}

interface Context {
  root: string
  dir: string
  /** path of dir relative to root, for git pathspecs; '' for the root */
  rel: string
  baseHashes: Record<string, string>
}

export async function resolveContext(config: SyncConfig, state: SyncState): Promise<Context> {
  const root = await repoRoot(config.repoPath)
  const dir = path.resolve(config.repoPath, config.subdir || '.')
  const rel = path.relative(root, dir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new GitError('The sub-folder must be inside the repository')
  }
  if (!state[root]) state[root] = {}
  return { root, dir, rel, baseHashes: state[root] }
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && /\.sql$/i.test(entry.name)) out.push(full)
  }
}

function readRepo(dir: string, warnings: string[]): Map<string, RepoFile> {
  const files: string[] = []
  walk(dir, files)
  const byTitle = new Map<string, RepoFile>()
  for (const file of files) {
    const query = parseQueryFile(fs.readFileSync(file, 'utf8'), path.basename(file))
    if (byTitle.has(query.title)) {
      warnings.push(`Two files are titled "${query.title}"; only ${path.relative(dir, byTitle.get(query.title).file)} is used`)
      continue
    }
    byTitle.set(query.title, { file, query })
  }
  return byTitle
}

async function readLocal(store: QueryStore, warnings: string[]): Promise<Map<string, QueryFile>> {
  const byTitle = new Map<string, QueryFile>()
  for (const query of await store.list()) {
    const title = query.title.replace(/\s+/g, ' ').trim()
    if (byTitle.has(title)) {
      warnings.push(`Two saved queries are titled "${title}"; only one is synced`)
      continue
    }
    byTitle.set(title, { ...query, title })
  }
  return byTitle
}

function conflictOf(title: string, local: QueryFile, repo: QueryFile): Conflict {
  return {
    title,
    local: { text: local.text, database: local.database },
    repo: { text: repo.text, database: repo.database },
  }
}

function writeQueryFile(ctx: Context, query: QueryFile, repo: Map<string, RepoFile>): void {
  const existing = repo.get(query.title)
  let file: string
  if (existing) {
    file = existing.file
  } else {
    fs.mkdirSync(ctx.dir, { recursive: true })
    const taken = new Set(fs.readdirSync(ctx.dir).map((n) => n.toLowerCase()))
    file = path.join(ctx.dir, safeFileName(query.title, taken))
  }
  const resolved = path.resolve(file)
  if (path.relative(ctx.dir, resolved).startsWith('..')) {
    throw new GitError(`Refusing to write outside the sync folder: ${file}`)
  }
  fs.writeFileSync(resolved, renderQueryFile(query))
  repo.set(query.title, { file: resolved, query })
}

function titles(local: Map<string, QueryFile>, repo: Map<string, RepoFile>): string[] {
  return Array.from(new Set([...local.keys(), ...repo.keys()]))
}

/** Counts what differs, without touching anything. */
export async function status(config: SyncConfig, store: QueryStore, state: SyncState, doFetch: boolean): Promise<SyncStatus> {
  const ctx = await resolveContext(config, state)
  if (doFetch) await fetch(ctx.root)
  const info = await branchInfo(ctx.root)
  const warnings: string[] = []
  const local = await readLocal(store, warnings)
  const repo = readRepo(ctx.dir, warnings)
  let pendingPush = 0
  let pendingPull = 0
  let conflicts = 0
  for (const title of titles(local, repo)) {
    const l = local.get(title)
    const r = repo.get(title)
    switch (classify(l && hashQuery(l), r && hashQuery(r.query), ctx.baseHashes[title])) {
      case 'toRepo': case 'newLocal': pendingPush++; break
      case 'toLocal': case 'newRepo': pendingPull++; break
      case 'conflict': conflicts++; break
    }
  }
  return { ...info, root: ctx.root, pendingPush, pendingPull, conflicts }
}

export async function pull(config: SyncConfig, store: QueryStore, state: SyncState): Promise<PullResult> {
  const ctx = await resolveContext(config, state)
  await fetch(ctx.root)
  const info = await branchInfo(ctx.root)
  let fastForwarded = false
  if (info.behind > 0) {
    await pullFastForward(ctx.root)
    fastForwarded = true
  }

  const result: PullResult = { fastForwarded, created: [], updated: [], conflicts: [], warnings: [] }
  const local = await readLocal(store, result.warnings)
  const repo = readRepo(ctx.dir, result.warnings)
  for (const title of titles(local, repo)) {
    const l = local.get(title)
    const r = repo.get(title)
    const rHash = r && hashQuery(r.query)
    switch (classify(l && hashQuery(l), rHash, ctx.baseHashes[title])) {
      case 'newRepo':
        await store.create(r.query)
        result.created.push(title)
        ctx.baseHashes[title] = rHash
        break
      case 'toLocal':
        await store.update(title, { text: r.query.text, database: r.query.database })
        result.updated.push(title)
        ctx.baseHashes[title] = rHash
        break
      case 'same':
        if (l && r) ctx.baseHashes[title] = rHash
        break
      case 'conflict':
        result.conflicts.push(conflictOf(title, l, r.query))
        break
    }
  }
  return result
}

export async function push(config: SyncConfig, store: QueryStore, state: SyncState, message = 'Update saved queries'): Promise<PushResult> {
  const ctx = await resolveContext(config, state)
  await fetch(ctx.root)
  const info = await branchInfo(ctx.root)
  if (!info.upstream) {
    throw new GitError(`Branch ${info.branch} has no upstream. Run "git push -u <remote> ${info.branch}" once in the repository.`)
  }
  if (info.behind > 0) {
    throw new GitError(`${info.branch} is ${info.behind} commit(s) behind ${info.upstream}. Pull first.`)
  }

  const result: PushResult = { written: [], needPull: [], conflicts: [], committed: false, pushed: false, warnings: [] }
  const local = await readLocal(store, result.warnings)
  const repo = readRepo(ctx.dir, result.warnings)
  for (const title of titles(local, repo)) {
    const l = local.get(title)
    const r = repo.get(title)
    const lHash = l && hashQuery(l)
    switch (classify(lHash, r && hashQuery(r.query), ctx.baseHashes[title])) {
      case 'toRepo':
      case 'newLocal':
        writeQueryFile(ctx, l, repo)
        result.written.push(title)
        ctx.baseHashes[title] = lHash
        break
      case 'toLocal':
      case 'newRepo':
        result.needPull.push(title)
        break
      case 'same':
        if (l && r) ctx.baseHashes[title] = lHash
        break
      case 'conflict':
        result.conflicts.push(conflictOf(title, l, r.query))
        break
    }
  }

  result.committed = await commitPath(ctx.root, ctx.rel, message)
  const after = await branchInfo(ctx.root)
  if (after.ahead > 0) {
    await gitPush(ctx.root)
    result.pushed = true
  }
  return result
}

/** Applies the user's choices for queries that changed on both sides. */
export async function resolve(config: SyncConfig, store: QueryStore, state: SyncState, resolutions: Resolution[]): Promise<number> {
  const ctx = await resolveContext(config, state)
  const warnings: string[] = []
  const local = await readLocal(store, warnings)
  const repo = readRepo(ctx.dir, warnings)
  let done = 0
  for (const { title, choice } of resolutions) {
    const l = local.get(title)
    const r = repo.get(title)
    if (!l || !r) continue
    if (choice === 'repo') {
      await store.update(title, { text: r.query.text, database: r.query.database })
      ctx.baseHashes[title] = hashQuery(r.query)
    } else {
      if (choice === 'both') {
        await store.create({ title: `${title} (repo)`, text: r.query.text, database: r.query.database })
      }
      // the file now holds the local version; the next push commits it
      writeQueryFile(ctx, l, repo)
      ctx.baseHashes[title] = hashQuery(l)
    }
    done++
  }
  return done
}

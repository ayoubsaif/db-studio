import * as path from 'path'
import platformInfo from '@/common/platform_info'
import { FavoriteQuery } from '@/common/appdb/models/favorite_query'
import { UserSetting } from '@/common/appdb/models/user_setting'
import { repoRoot } from '@/lib/gitSync/git'
import { QueryFile } from '@/lib/gitSync/format'
import { loadState, saveState, SyncState } from '@/lib/gitSync/state'
import { pull, push, QueryStore, resolve, Resolution, status, SyncConfig } from '@/lib/gitSync/sync'

const CONFIG_KEY = 'gitSyncConfig'

export interface GitSyncConfig extends SyncConfig {
  autoFetch: boolean
  /** minutes between automatic fetches */
  interval: number
}

const DEFAULT_CONFIG: GitSyncConfig = { repoPath: '', subdir: '', autoFetch: true, interval: 5 }

function normalize(input: Partial<GitSyncConfig>): GitSyncConfig {
  const interval = Math.floor(Number(input.interval))
  return {
    repoPath: (input.repoPath ?? '').trim(),
    subdir: (input.subdir ?? '').trim().replace(/^[\\/]+|[\\/]+$/g, ''),
    autoFetch: input.autoFetch !== false,
    interval: Number.isFinite(interval) && interval >= 1 ? interval : DEFAULT_CONFIG.interval,
  }
}

async function loadConfig(): Promise<GitSyncConfig> {
  const setting = await UserSetting.get(CONFIG_KEY)
  if (!setting?._userValue) return { ...DEFAULT_CONFIG }
  try {
    return normalize(JSON.parse(setting._userValue))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

const queryStore: QueryStore = {
  async list(): Promise<QueryFile[]> {
    const rows = await FavoriteQuery.find()
    return rows.map((r) => ({ title: r.title, text: r.text, database: r.database }))
  },
  async create(query) {
    const row = new FavoriteQuery()
    row.title = query.title
    row.text = query.text
    row.database = query.database
    await row.save()
  },
  async update(title, changes) {
    const rows = await FavoriteQuery.find()
    const row = rows.find((r) => r.title.replace(/\s+/g, ' ').trim() === title)
    if (!row) throw new Error(`Saved query "${title}" was not found`)
    row.text = changes.text
    row.database = changes.database
    await row.save()
  },
}

function stateFile(): string {
  return path.join(platformInfo.userDirectory, 'git-sync-state.json')
}

/** Git operations must not overlap: a periodic fetch during a push would race with it. */
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

async function withRepo<T>(task: (config: GitSyncConfig, state: SyncState) => Promise<T>): Promise<T> {
  return serialized(async () => {
    const config = await loadConfig()
    if (!config.repoPath) throw new Error('Choose a git repository first')
    const state = loadState(stateFile())
    try {
      return await task(config, state)
    } finally {
      // even a failed push may have updated what was already written
      saveState(stateFile(), state)
    }
  })
}

export const GitSyncHandlers = {
  'gitSync/config/get': async () => loadConfig(),

  'gitSync/config/set': async function({ config }: { config: Partial<GitSyncConfig> }) {
    const next = normalize(config)
    if (next.repoPath) {
      await repoRoot(next.repoPath) // throws "<path> is not a git repository"
    }
    await UserSetting.set(CONFIG_KEY, JSON.stringify(next))
    return next
  },

  /** null when no repository is configured */
  'gitSync/status': async function({ fetch }: { fetch?: boolean }) {
    return serialized(async () => {
      const config = await loadConfig()
      if (!config.repoPath) return null
      return status(config, queryStore, loadState(stateFile()), !!fetch)
    })
  },

  'gitSync/pull': async () => withRepo((config, state) => pull(config, queryStore, state)),

  'gitSync/push': async () => withRepo((config, state) => push(config, queryStore, state)),

  'gitSync/resolve': async function({ resolutions }: { resolutions: Resolution[] }) {
    return withRepo((config, state) => resolve(config, queryStore, state, resolutions))
  },
}

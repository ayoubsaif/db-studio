import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { pull, push, resolve, status, QueryStore, SyncConfig } from '@/lib/gitSync/sync'
import { QueryFile } from '@/lib/gitSync/format'
import { SyncState } from '@/lib/gitSync/state'

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}

class MemoryStore implements QueryStore {
  queries: QueryFile[] = []
  async list() { return this.queries.map((q) => ({ ...q })) }
  async create(q: QueryFile) { this.queries.push({ ...q }) }
  async update(title: string, c: { text: string, database: string | null }) {
    Object.assign(this.queries.find((q) => q.title === title), c)
  }
  text(title: string) { return this.queries.find((q) => q.title === title)?.text }
}

/** one "machine": a clone of the shared remote, its own app store and sync state */
class Machine {
  store = new MemoryStore()
  state: SyncState = {}
  config: SyncConfig
  constructor(public dir: string, subdir = 'queries') {
    this.config = { repoPath: dir, subdir }
  }
  pull() { return pull(this.config, this.store, this.state) }
  push() { return push(this.config, this.store, this.state) }
  status(fetch = true) { return status(this.config, this.store, this.state, fetch) }
  file(name: string) { return path.join(this.dir, 'queries', name) }
}

describe('git query sync', () => {
  let tmp: string
  let a: Machine
  let b: Machine

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-gitsync-'))
    const remote = path.join(tmp, 'remote.git')
    git(tmp, 'init', '--bare', '--initial-branch=main', remote)
    const seed = path.join(tmp, 'seed')
    git(tmp, 'clone', remote, seed)
    for (const dir of [seed]) {
      git(dir, 'config', 'user.email', 'test@example.com')
      git(dir, 'config', 'user.name', 'Test')
    }
    fs.writeFileSync(path.join(seed, 'README.md'), '# queries\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-m', 'init')
    git(seed, 'push', 'origin', 'HEAD:main')
    const clone = (name: string) => {
      const dir = path.join(tmp, name)
      git(tmp, 'clone', remote, dir)
      git(dir, 'config', 'user.email', 'test@example.com')
      git(dir, 'config', 'user.name', 'Test')
      return new Machine(dir)
    }
    a = clone('a')
    b = clone('b')
  })

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('rejects a folder that is not a repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-notgit-'))
    try {
      await expect(status({ repoPath: plain, subdir: '' }, new MemoryStore(), {}, false)).rejects.toThrow(/not a git repository/)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })

  it('pushes new queries as files, commits and pushes', async () => {
    a.store.queries.push({ title: 'Monthly sales', database: 'shop', text: 'SELECT 1' })
    const result = await a.push()
    expect(result).toMatchObject({ written: ['Monthly sales'], committed: true, pushed: true, conflicts: [] })
    expect(fs.readFileSync(a.file('Monthly sales.sql'), 'utf8')).toContain('-- bks:title: Monthly sales')
    expect(git(a.dir, 'log', '--oneline').split('\n').length).toBeGreaterThan(2)
    expect((await a.status()).ahead).toBe(0)
  })

  it('makes no commit when nothing changed', async () => {
    a.store.queries.push({ title: 'q', database: null, text: 'SELECT 1' })
    await a.push()
    const second = await a.push()
    expect(second).toMatchObject({ written: [], committed: false, pushed: false })
  })

  it('pulls queries pushed from another machine, then updates them', async () => {
    a.store.queries.push({ title: 'q', database: null, text: 'SELECT 1' })
    await a.push()

    const first = await b.pull()
    expect(first).toMatchObject({ fastForwarded: true, created: ['q'], conflicts: [] })
    expect(b.store.text('q')).toBe('SELECT 1')

    a.store.queries[0].text = 'SELECT 2'
    await a.push()
    const second = await b.pull()
    expect(second.updated).toEqual(['q'])
    expect(b.store.text('q')).toBe('SELECT 2')
  })

  it('imports plain .sql files that have no header', async () => {
    fs.mkdirSync(a.file(''), { recursive: true })
    fs.writeFileSync(a.file('report.sql'), 'SELECT * FROM t;\n')
    git(a.dir, 'add', '.')
    git(a.dir, 'commit', '-m', 'add plain file')
    git(a.dir, 'push')
    const result = await b.pull()
    expect(result.created).toEqual(['report'])
    expect(b.store.text('report')).toBe('SELECT * FROM t;')
  })

  it('refuses to push while behind, and writes nothing', async () => {
    a.store.queries.push({ title: 'q', database: null, text: 'one' })
    await a.push()
    b.store.queries.push({ title: 'other', database: null, text: 'two' })
    await expect(b.push()).rejects.toThrow(/behind .* Pull first/)
    expect(fs.existsSync(b.file('other.sql'))).toBe(false)
  })

  it('does not overwrite a changed repository file with a stale local query on push', async () => {
    a.store.queries.push({ title: 'q', database: null, text: 'v1' })
    await a.push()
    await b.pull()
    a.store.queries[0].text = 'v2'
    await a.push()
    // b has not pulled v2; its own copy is unchanged, so a push must leave v2 alone
    await b.pull()
    const result = await b.push()
    expect(result.written).toEqual([])
    expect(b.store.text('q')).toBe('v2')
  })

  it('reports a conflict instead of overwriting, then applies the chosen resolution', async () => {
    a.store.queries.push({ title: 'q', database: null, text: 'base' })
    await a.push()
    await b.pull()

    a.store.queries[0].text = 'from A'
    await a.push()
    b.store.queries[0].text = 'from B'

    const pulled = await b.pull()
    expect(pulled.conflicts).toHaveLength(1)
    expect(pulled.conflicts[0]).toMatchObject({ title: 'q', local: { text: 'from B' }, repo: { text: 'from A' } })
    expect(b.store.text('q')).toBe('from B')

    await resolve(b.config, b.store, b.state, [{ title: 'q', choice: 'both' }])
    expect(b.store.queries.map((q) => q.title).sort()).toEqual(['q', 'q (repo)'])
    expect(b.store.text('q (repo)')).toBe('from A')

    const pushed = await b.push()
    expect(pushed.conflicts).toEqual([])
    expect(pushed.pushed).toBe(true)
    await a.pull()
    expect(a.store.text('q')).toBe('from B')
    expect(a.store.text('q (repo)')).toBe('from A')
  })

  it('takes the repository version when asked', async () => {
    a.store.queries.push({ title: 'q', database: null, text: 'base' })
    await a.push()
    await b.pull()
    a.store.queries[0].text = 'from A'
    await a.push()
    b.store.queries[0].text = 'from B'
    await b.pull()
    await resolve(b.config, b.store, b.state, [{ title: 'q', choice: 'repo' }])
    expect(b.store.text('q')).toBe('from A')
    expect((await b.pull()).conflicts).toEqual([])
  })

  it('does not bring back a query removed locally, or delete one removed in the repository', async () => {
    a.store.queries.push({ title: 'q', database: null, text: 'x' })
    await a.push()
    await b.pull()

    b.store.queries = []
    expect((await b.pull()).created).toEqual([])

    fs.rmSync(a.file('q.sql'))
    expect((await a.pull()).conflicts).toEqual([])
    expect(a.store.text('q')).toBe('x')
  })

  it('counts pending changes in the status', async () => {
    a.store.queries.push({ title: 'q', database: null, text: 'x' })
    expect(await a.status()).toMatchObject({ pendingPush: 1, pendingPull: 0, ahead: 0, behind: 0, branch: 'main' })
    await a.push()
    // fetched but not pulled: the files are not in the working tree yet, so only `behind` shows it
    expect(await b.status()).toMatchObject({ pendingPull: 0, behind: 1 })
    await b.pull()
    expect(await b.status()).toMatchObject({ pendingPull: 0, pendingPush: 0, behind: 0 })
  })

  it('refuses a sub-folder outside the repository', async () => {
    await expect(pull({ repoPath: a.dir, subdir: '../escape' }, new MemoryStore(), {})).rejects.toThrow(/inside the repository/)
  })
})

import { execFile } from 'child_process'

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

export interface BranchInfo {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
}

const TIMEOUT_MS = 60_000

/** Runs git without a shell, in `cwd`, and never waits for a terminal prompt. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git', args,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new GitError('git was not found. Install git and make sure it is on your PATH.'))
        }
        const detail = (stderr || stdout || error.message).toString().trim()
        reject(new GitError(detail || `git ${args[0]} failed`))
      }
    )
  })
}

/** The root of the working tree that contains `dir`; throws a GitError when there is none. */
export async function repoRoot(dir: string): Promise<string> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch (e) {
    if (e instanceof GitError && /not a git repository/i.test(e.message)) {
      throw new GitError(`${dir} is not a git repository`)
    }
    if (e instanceof GitError && /cannot change to|no such file|not a directory/i.test(e.message)) {
      throw new GitError(`${dir} does not exist`)
    }
    throw e
  }
}

export async function branchInfo(root: string): Promise<BranchInfo> {
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  let upstream: string | null = null
  try {
    upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim()
  } catch {
    // no upstream configured
  }
  let ahead = 0
  let behind = 0
  if (upstream) {
    const [a, b] = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/)
    ahead = parseInt(a, 10) || 0
    behind = parseInt(b, 10) || 0
  }
  return { branch, upstream, ahead, behind }
}

export async function fetch(root: string): Promise<void> {
  await git(root, ['fetch', '--quiet'])
}

export async function pullFastForward(root: string): Promise<void> {
  await git(root, ['pull', '--ff-only', '--quiet'])
}

/** Stages and commits only `relPath`. Returns false when there was nothing to commit. */
export async function commitPath(root: string, relPath: string, message: string): Promise<boolean> {
  const spec = relPath || '.'
  await git(root, ['add', '-A', '--', spec])
  const staged = (await git(root, ['diff', '--cached', '--name-only', '--', spec])).trim()
  if (!staged) return false
  await git(root, ['commit', '--quiet', '-m', message, '--', spec])
  return true
}

export async function push(root: string): Promise<void> {
  await git(root, ['push', '--quiet'])
}

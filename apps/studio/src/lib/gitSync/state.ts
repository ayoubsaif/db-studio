import * as fs from 'fs'
import * as path from 'path'

/** repository root -> query title -> content hash at the last sync */
export type SyncState = Record<string, Record<string, string>>

export function loadState(file: string): SyncState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveState(file: string, state: SyncState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state, null, 2))
  fs.renameSync(temp, file)
}

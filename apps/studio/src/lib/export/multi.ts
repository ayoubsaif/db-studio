import path from 'path'
import { TableOrView } from '../db/models'

/** What to do when a multi-table export would write over an existing file. */
export type ExistingFileMode = 'overwrite' | 'skip' | 'number'

// characters Windows refuses in file names, plus control characters
// eslint-disable-next-line no-control-regex
const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g
// device names Windows reserves regardless of extension
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const MAX_BASE_LENGTH = 200

/** `<schema>.<table>.<ext>`, or `<table>.<ext>` when there is no schema, made safe for any OS. */
export function exportFileName(table: Pick<TableOrView, 'name' | 'schema'>, extension: string): string {
  const raw = table.schema ? `${table.schema}.${table.name}` : table.name
  let base = raw.replace(INVALID_FILE_CHARS, '_').replace(/[. ]+$/, '').slice(0, MAX_BASE_LENGTH)
  if (!base || RESERVED_NAMES.test(base)) base = `_${base}`
  return `${base}.${extension}`
}

/**
 * Picks where one table of a multi-table export is written, or null when it
 * should be skipped. `taken` holds paths already used in this run (lower-cased,
 * since Windows and macOS file names ignore case) so two tables never share a file.
 */
export function resolveTargetPath(
  directory: string,
  fileName: string,
  mode: ExistingFileMode,
  exists: (filePath: string) => boolean,
  taken: Set<string> = new Set()
): string | null {
  const isFree = (p: string) => !taken.has(p.toLowerCase()) && !exists(p)
  const first = path.join(directory, fileName)

  // overwrite/skip only apply to files that were there before this run;
  // a clash between two tables of the same run always gets a number
  if (!taken.has(first.toLowerCase()) && exists(first)) {
    if (mode === 'skip') return null
    if (mode === 'overwrite') return claim(first, taken)
  }
  if (isFree(first)) return claim(first, taken)

  const ext = path.extname(fileName)
  const base = fileName.slice(0, fileName.length - ext.length)
  for (let n = 2; n < 10000; n++) {
    const candidate = path.join(directory, `${base} (${n})${ext}`)
    if (isFree(candidate)) return claim(candidate, taken)
  }
  throw new Error(`Could not find a free file name for ${fileName}`)
}

function claim(filePath: string, taken: Set<string>): string {
  taken.add(filePath.toLowerCase())
  return filePath
}

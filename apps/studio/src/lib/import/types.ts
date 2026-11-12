/**
 * Shared types for importing CSV and Excel files into an existing table.
 * The pipeline is: reader -> mapper -> converter -> batcher -> writer.
 */

export type ImportMode = 'append' | 'update' | 'appendUpdate' | 'appendNoUpdate' | 'delete' | 'copy'

export const ImportModes: ImportMode[] = ['append', 'update', 'appendUpdate', 'appendNoUpdate', 'delete', 'copy']

/** Modes that match file rows to table rows by key columns. */
export const KeyedModes: ImportMode[] = ['update', 'appendUpdate', 'appendNoUpdate', 'delete']

/** Modes that can insert rows, so required columns must be mapped. */
export const InsertingModes: ImportMode[] = ['append', 'appendUpdate', 'appendNoUpdate', 'copy']

export type FileFormat = 'csv' | 'xlsx'

export interface CsvParseOptions {
  /** empty string means auto-detect */
  delimiter?: string
  quoteChar?: string
  /** any label TextDecoder understands, for example utf-8, windows-1252, utf-16le */
  encoding?: string
}

export interface ParseOptions {
  format: FileFormat
  csv?: CsvParseOptions
  /** worksheet name for xlsx; the first sheet when empty */
  sheet?: string
  /** 1-based row number of the header row, or null when the file has no header */
  headerRow: number | null
  /** 1-based row number of the first data row; defaults to the row after the header */
  firstDataRow?: number
  /** 1-based row number of the last data row to read, inclusive */
  lastDataRow?: number | null
}

/** One data row read from a file. `rowNumber` is the row number shown to the user. */
export interface FileRow {
  rowNumber: number
  values: FileValue[]
}

/** CSV values are strings; Excel values can also be numbers and booleans. Dates arrive as ISO strings. */
export type FileValue = string | number | boolean | null

export interface FileSample {
  columns: string[]
  rows: FileRow[]
  /** worksheet names, for xlsx */
  sheets?: string[]
}

export interface ColumnMapping {
  /** index of the column in the file */
  fileIndex: number
  fileColumn: string
  /** target column, or null to skip the file column */
  tableColumn: string | null
}

export interface TargetColumn {
  name: string
  dataType: string
  nullable?: boolean
  hasDefault?: boolean
  /** generated or identity columns that can't be written */
  generated?: boolean
}

export interface ConvertOptions {
  /** '.' or ',' */
  decimalSeparator: '.' | ','
  /** dayjs-style tokens, for example YYYY-MM-DD or DD/MM/YYYY; ISO dates are always accepted */
  dateFormat: string
  emptyAsNull: boolean
}

export type ErrorMode = 'stop' | 'continue'

export interface ImportOptions extends ConvertOptions {
  mode: ImportMode
  keyColumns: string[]
  useTransaction: boolean
  batchSize: number
  errorMode: ErrorMode
  /** use the database's own upsert/insert-ignore when the keys match a unique constraint (default true) */
  nativeUpsert?: boolean
}

/** Input for a client's native upsert fast path. */
export interface ImportUpsertSpec {
  target: ImportTarget
  mode: 'appendUpdate' | 'appendNoUpdate'
  keyColumns: string[]
  /** every column written, keys included */
  columns: string[]
  rows: Record<string, any>[]
}

export interface ImportTarget {
  table: string
  schema?: string | null
}

export interface ImportRequest {
  filePath: string
  parse: ParseOptions
  target: ImportTarget
  mappings: ColumnMapping[]
  options: ImportOptions
}

export interface RowError {
  rowNumber: number
  column?: string
  value?: any
  message: string
}

export type ImportStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ImportCounts {
  read: number
  inserted: number
  updated: number
  deleted: number
  skipped: number
  failed: number
  /** rows whose key appeared earlier in the file; they are also counted in one of the counts above */
  duplicateKeys: number
}

export interface ImportProgress extends ImportCounts {
  status: ImportStatus
}

export interface ImportSummary extends ImportCounts {
  status: ImportStatus
  /** failed rows, capped at maxReportedErrors; `failed` holds the full count */
  errors: RowError[]
  /** a fatal error that stopped the import */
  error: string | null
  /** true when changes were rolled back */
  rolledBack: boolean
  warnings: string[]
  /** whether the database's own upsert was used */
  nativeUpsert?: boolean
  elapsedMs: number
}

export const maxReportedErrors = 1000

export function emptyCounts(): ImportCounts {
  return { read: 0, inserted: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, duplicateKeys: 0 }
}

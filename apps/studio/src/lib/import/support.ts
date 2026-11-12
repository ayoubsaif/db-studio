import { Dialect } from '@shared/lib/dialects/models'
import { ImportMode, ImportModes } from './types'

export interface ModeSupport {
  mode: ImportMode
  enabled: boolean
  /** why the mode is disabled, or a caution shown next to it */
  note?: string
}

export interface DialectImportSupport {
  modes: ModeSupport[]
  /** whether the whole import can run in one transaction and be rolled back */
  transactions: boolean
  /** shown before running */
  warnings: string[]
}

const noRollback = "Changes are applied as they go and can't be rolled back."

/** What each database can do when importing. Databases not listed support every mode in a transaction. */
export function importSupport(dialect: Dialect): DialectImportSupport {
  const all = (notes: Partial<Record<ImportMode, string>> = {}): ModeSupport[] =>
    ImportModes.map((mode) => ({ mode, enabled: true, note: notes[mode] }))

  switch (dialect) {
    case 'clickhouse': {
      const mutation = 'Runs as ClickHouse mutations (ALTER TABLE ... UPDATE), one row at a time. Rows with the same key values are all changed.'
      return {
        modes: all({ update: mutation, appendUpdate: mutation }),
        transactions: false,
        warnings: [noRollback],
      }
    }
    case 'cassandra': {
      const overwrite = 'Cassandra inserts always overwrite an existing row with the same key, so this mode is not possible.'
      return {
        modes: ImportModes.map((mode) => mode === 'update' || mode === 'appendNoUpdate'
          ? { mode, enabled: false, note: overwrite }
          : { mode, enabled: true }),
        transactions: false,
        warnings: [noRollback],
      }
    }
    case 'bigquery':
      return {
        modes: all(),
        transactions: false,
        warnings: [noRollback, 'Each batch runs as a DML statement and counts toward BigQuery DML quotas.'],
      }
    default:
      return { modes: all(), transactions: true, warnings: [] }
  }
}

export function isModeEnabled(dialect: Dialect, mode: ImportMode): boolean {
  return !!importSupport(dialect).modes.find((m) => m.mode === mode && m.enabled)
}

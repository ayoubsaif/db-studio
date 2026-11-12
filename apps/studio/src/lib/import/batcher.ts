import { Dialect } from '@shared/lib/dialects/models'

export const defaultBatchSize = 500

/** Bound parameters per statement, and row caps that apply regardless of column count. */
const limits: Partial<Record<Dialect, { parameters?: number, rows?: number }>> = {
  // 2100 parameters per request; INSERT ... VALUES accepts at most 1000 rows
  sqlserver: { parameters: 2100, rows: 1000 },
  // SQLITE_MAX_VARIABLE_NUMBER is 32766 since SQLite 3.32 (999 before)
  sqlite: { parameters: 32766 },
  postgresql: { parameters: 65535 },
  redshift: { parameters: 32767 },
  mysql: { parameters: 65535 },
  // IN lists are limited to 1000 values
  oracle: { rows: 1000 },
  // statements are limited to 64 KB on Firebird 2.5
  firebird: { rows: 100 },
  cassandra: { rows: 100 },
  bigquery: { rows: 1000 },
}

/** The largest batch the database accepts for `columnCount` columns, never more than `requested`. */
export function maxBatchSize(dialect: Dialect, columnCount: number, requested = defaultBatchSize): number {
  const limit = limits[dialect] || {}
  let size = Math.max(1, Math.floor(requested || defaultBatchSize))
  if (limit.parameters) size = Math.min(size, Math.floor(limit.parameters / Math.max(1, columnCount)))
  if (limit.rows) size = Math.min(size, limit.rows)
  return Math.max(1, size)
}

/** Groups an async stream into arrays of at most `size` items. */
export async function* batches<T>(items: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let batch: T[] = []
  for await (const item of items) {
    batch.push(item)
    if (batch.length >= size) {
      yield batch
      batch = []
    }
  }
  if (batch.length) yield batch
}

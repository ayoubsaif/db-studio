import { Knex } from 'knex'
import { Dialect } from '@shared/lib/dialects/models'
import { ImportTarget } from './types'

/** Databases that accept `(a, b) IN ((1, 2), (3, 4))`. The rest get `OR` of `AND` groups. */
const tupleInDialects: Dialect[] = ['postgresql', 'redshift', 'mysql', 'sqlite', 'oracle', 'clickhouse']

export function supportsTupleIn(dialect: Dialect): boolean {
  return tupleInDialects.includes(dialect)
}

export function table(knex: Knex, target: ImportTarget) {
  const builder = knex(target.table)
  return target.schema ? builder.withSchema(target.schema) : builder
}

/** Adds `WHERE <keys> IN (<tuples>)` to a builder. */
export function whereKeys(builder: Knex.QueryBuilder, dialect: Dialect, keyColumns: string[], tuples: any[][]) {
  if (keyColumns.length === 1) return builder.whereIn(keyColumns[0], tuples.map((t) => t[0]))
  if (supportsTupleIn(dialect)) return builder.whereIn(keyColumns as any, tuples)
  return builder.where((group) => {
    for (const tuple of tuples) {
      group.orWhere((and) => {
        keyColumns.forEach((column, i) => and.where(column, tuple[i]))
      })
    }
  })
}

/** SQL that returns the key columns, aliased k0, k1, ..., of the table rows matching `tuples`. */
export function keyLookupQuery(knex: Knex, dialect: Dialect, target: ImportTarget, keyColumns: string[], tuples: any[][]): string {
  const select = Object.fromEntries(keyColumns.map((column, i) => [`k${i}`, column]))
  return whereKeys(table(knex, target).select(select), dialect, keyColumns, tuples).toQuery()
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, '0')
}

const numeric = /^[+-]?\d+(\.\d+)?$/

/**
 * Normalizes one key value so a value read from the file and the same value
 * returned by the database driver compare equal.
 */
export function normalizeKeyPart(value: any): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) {
    // drivers return date and timestamp columns as local-time Dates
    const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
    const ms = value.getMilliseconds()
    if (!value.getHours() && !value.getMinutes() && !value.getSeconds() && !ms) return day
    return `${day} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}${ms ? '.' + pad(ms, 3) : ''}`
  }
  if (Buffer.isBuffer(value)) return 'x' + value.toString('hex')
  let text = typeof value === 'number' ? String(value) : String(value)
  if (numeric.test(text)) {
    text = text.replace(/^\+/, '')
    const negative = text.startsWith('-')
    let [int, frac] = text.replace(/^-/, '').split('.')
    int = int.replace(/^0+(?=\d)/, '')
    frac = (frac || '').replace(/0+$/, '')
    const out = frac ? `${int}.${frac}` : int
    return negative && out !== '0' ? '-' + out : out
  }
  const date = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/)
  if (date) {
    const ms = (date[3] || '').replace(/0+$/, '')
    if (date[2] === '00:00:00' && (!ms || ms === '.')) return date[1]
    return `${date[1]} ${date[2]}${ms.length > 1 ? ms : ''}`
  }
  return text
}

/** A string that identifies a key tuple, or null when any part is NULL (NULL never matches). */
export function keyString(values: any[]): string | null {
  const parts = values.map(normalizeKeyPart)
  if (parts.some((p) => p === null)) return null
  return JSON.stringify(parts)
}

/** Case- and trailing-space-insensitive form, for databases whose collation compares that way. */
export function looseKeyString(key: string): string {
  return (JSON.parse(key) as string[]).map((p) => p.toLowerCase().replace(/\s+$/, '')).join('\u0000')
}

/** The set of keys found in the table, with a fallback for case-insensitive collations. */
export class ExistingKeys {
  private exact = new Set<string>()
  private loose = new Map<string, number>()

  add(key: string) {
    if (this.exact.has(key)) return
    this.exact.add(key)
    const l = looseKeyString(key)
    this.loose.set(l, (this.loose.get(l) || 0) + 1)
  }

  /**
   * The database only returned rows it considers equal to a file key, so a
   * single loose match means the database's collation matched it.
   */
  has(key: string): boolean {
    return this.exact.has(key) || this.loose.get(looseKeyString(key)) === 1
  }
}

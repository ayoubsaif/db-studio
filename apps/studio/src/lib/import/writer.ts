import { Knex } from 'knex'
import { Dialect } from '@shared/lib/dialects/models'
import { NgQueryResult } from '@/lib/db/models'
import { ConvertedRow } from './converter'
import { ExistingKeys, keyLookupQuery, keyString, table, whereKeys } from './keys'
import { ImportSession } from './session'
import { ErrorMode, ImportCounts, ImportMode, ImportTarget, RowError } from './types'

/** Thrown in stop-on-error mode; carries the row that failed. */
export class ImportStopError extends Error {
  constructor(public rowError: RowError) {
    super(`Row ${rowError.rowNumber}: ${rowError.message}`)
  }
}

export interface WriterOptions {
  session: ImportSession
  knex: Knex
  dialect: Dialect
  target: ImportTarget
  mode: ImportMode
  keyColumns: string[]
  /** every table column written, keys included */
  columns: string[]
  errorMode: ErrorMode
  counts: ImportCounts
  onRowError: (error: RowError) => void
  /** checked between statements so a cancel doesn't wait for a whole batch of retries */
  isCancelled?: () => boolean
  /**
   * The database's own upsert or insert-ignore for these rows, for Append/Update
   * and Append without update. Its result has one row per inserted or updated
   * row, with a boolean `inserted` column.
   */
  upsertSql?: (rows: Record<string, any>[]) => string | null
}

type OpKind = 'insert' | 'update' | 'delete' | 'upsert'

interface Op {
  kind: OpKind
  rows: ConvertedRow[]
}

const savepointName = 'bks_import_batch'
const rowSavepointName = 'bks_import_row'

export function errorMessage(e: any): string {
  return (e?.message || String(e)).replace(/\s+/g, ' ').trim()
}

export class ImportWriter {
  private seenKeys = new Set<string>()
  private valueColumns: string[]
  /** turns a value into what knex should write */
  private literal: (value: any) => any

  constructor(private o: WriterOptions) {
    this.valueColumns = o.columns.filter((c) => !o.keyColumns.includes(c))
    // SQL Server reads 'text' in the database's code page; N'text' keeps every character
    this.literal = o.dialect === 'sqlserver'
      ? (value) => typeof value === 'string' ? o.knex.raw('N?', [value]) : value
      : (value) => value
  }

  private literals(values: Record<string, any>): Record<string, any> {
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, this.literal(v)]))
  }

  private get usesUpsert() {
    return !!this.o.upsertSql && (this.o.mode === 'appendUpdate' || this.o.mode === 'appendNoUpdate')
  }

  /** Empties the table, for Copy mode. */
  async emptyTable() {
    const { knex, dialect, target } = this.o
    const name = target.schema
      ? `${knex.client.wrapIdentifier(target.schema)}.${knex.client.wrapIdentifier(target.table)}`
      : knex.client.wrapIdentifier(target.table)
    // TRUNCATE where it can be rolled back or there are no transactions anyway;
    // DELETE elsewhere, because TRUNCATE commits on MySQL and Oracle
    const truncate: Dialect[] = ['postgresql', 'clickhouse', 'cassandra', 'bigquery']
    const sql = truncate.includes(dialect) ? `TRUNCATE TABLE ${name}` : table(knex, target).del().toQuery()
    await this.o.session.execute(sql)
  }

  private keyValues(row: ConvertedRow) {
    return this.o.keyColumns.map((c) => row.values[c])
  }

  private sql(op: Op): string[] {
    const { knex, dialect, target, keyColumns } = this.o
    switch (op.kind) {
      case 'insert':
        return [table(knex, target).insert(op.rows.map((r) => this.literals(r.values))).toQuery()]
      case 'upsert':
        return [this.o.upsertSql(op.rows.map((r) => r.values))]
      case 'delete':
        return [whereKeys(table(knex, target), dialect, keyColumns, op.rows.map((r) => this.keyValues(r).map(this.literal))).del().toQuery()]
      default:
        return op.rows.map((r) => {
          const where = Object.fromEntries(keyColumns.map((c) => [c, this.literal(r.values[c])]))
          const set = Object.fromEntries(this.valueColumns.map((c) => [c, this.literal(r.values[c])]))
          return table(knex, target).where(where).update(set).toQuery()
        })
    }
  }

  private async findExisting(rows: ConvertedRow[]): Promise<ExistingKeys> {
    const existing = new ExistingKeys()
    const tuples = new Map<string, any[]>()
    for (const row of rows) {
      const values = this.keyValues(row)
      const key = keyString(values)
      if (key !== null) tuples.set(key, values)
    }
    if (!tuples.size) return existing
    const { knex, dialect, target, keyColumns } = this.o
    const lookup = [...tuples.values()].map((t) => t.map(this.literal))
    const [result] = await this.o.session.execute(keyLookupQuery(knex, dialect, target, keyColumns, lookup))
    const ids = keyColumns.map((_c, i) => fieldId(result, `k${i}`))
    for (const r of result?.rows || []) {
      const key = keyString(ids.map((id) => r[id]))
      if (key !== null) existing.add(key)
    }
    return existing
  }

  /**
   * Keeps one row per key: the last for Update and Append/Update, the first
   * otherwise. Rows that aren't applied count as skipped.
   */
  private collapse(rows: ConvertedRow[]) {
    const { mode, counts } = this.o
    const lastWins = mode === 'update' || mode === 'appendUpdate'
    const chosen = new Map<string, ConvertedRow>()
    const unkeyed: ConvertedRow[] = []
    for (const row of rows) {
      const key = keyString(this.keyValues(row))
      if (key === null) {
        // a NULL key never matches a table row
        unkeyed.push(row)
        continue
      }
      if (this.seenKeys.has(key)) counts.duplicateKeys++
      this.seenKeys.add(key)
      if (chosen.has(key)) {
        counts.skipped++
        if (lastWins) {
          chosen.delete(key)
          chosen.set(key, row)
        }
        continue
      }
      chosen.set(key, row)
    }
    return { chosen, unkeyed }
  }

  /** Decides what happens to each row of a batch. */
  async plan(rows: ConvertedRow[]): Promise<Op[]> {
    const { mode, counts } = this.o
    if (mode === 'append' || mode === 'copy') return [{ kind: 'insert', rows }]

    const { chosen, unkeyed } = this.collapse(rows)
    if (this.usesUpsert) return [{ kind: 'upsert', rows: [...chosen.values(), ...unkeyed] }]

    const existing = await this.findExisting([...chosen.values()])
    const inserts: ConvertedRow[] = []
    const updates: ConvertedRow[] = []
    const deletes: ConvertedRow[] = []
    for (const [key, row] of chosen) {
      const present = existing.has(key)
      switch (mode) {
        case 'update':
          if (present) updates.push(row)
          else counts.skipped++
          break
        case 'appendUpdate':
          (present ? updates : inserts).push(row)
          break
        case 'appendNoUpdate':
          if (present) counts.skipped++
          else inserts.push(row)
          break
        case 'delete':
          if (present) deletes.push(row)
          else counts.skipped++
          break
      }
    }
    for (const row of unkeyed) {
      if (mode === 'appendUpdate' || mode === 'appendNoUpdate') inserts.push(row)
      else counts.skipped++
    }

    const ops: Op[] = []
    if (inserts.length) ops.push({ kind: 'insert', rows: inserts })
    if (updates.length) ops.push({ kind: 'update', rows: updates })
    if (deletes.length) ops.push({ kind: 'delete', rows: deletes })
    return ops
  }

  private count(op: Op, results: NgQueryResult[]) {
    const { counts } = this.o
    const n = op.rows.length
    switch (op.kind) {
      case 'insert': counts.inserted += n; break
      case 'update': counts.updated += n; break
      case 'delete': counts.deleted += n; break
      case 'upsert': {
        const result = results[0]
        const returned = result?.rows || []
        const id = fieldId(result, 'inserted')
        const inserted = returned.filter((r) => r[id] === true || r[id] === 1 || r[id] === 't').length
        counts.inserted += inserted
        counts.updated += returned.length - inserted
        // insert-ignore returns nothing for rows it left alone
        counts.skipped += n - returned.length
        break
      }
    }
  }

  private async run(op: Op): Promise<NgQueryResult[]> {
    let results: NgQueryResult[] = []
    for (const s of this.sql(op)) results = await this.o.session.execute(s)
    return results
  }

  /** Writes one batch. Throws ImportStopError in stop mode when a row fails. */
  async write(rows: ConvertedRow[]) {
    const { session } = this.o
    const ops = await this.plan(rows)
    if (!ops.length) return

    if (session.savepoints) await session.savepoint(savepointName)
    const done: { op: Op, results: NgQueryResult[] }[] = []
    try {
      for (const op of ops) done.push({ op, results: await this.run(op) })
    } catch (e) {
      if (session.savepoints) {
        // undo the whole batch, then find the failing rows one at a time
        await session.rollbackTo(savepointName)
        await this.retryRows(ops)
        await session.release(savepointName)
      } else {
        // without savepoints, statements that ran stay applied
        done.forEach(({ op, results }) => this.count(op, results))
        await this.retryRows(ops.slice(done.length))
      }
      return
    }
    if (session.savepoints) await session.release(savepointName)
    done.forEach(({ op, results }) => this.count(op, results))
  }

  private async retryRows(ops: Op[]) {
    const { session, errorMode, counts } = this.o
    for (const op of ops) {
      for (const row of op.rows) {
        if (this.o.isCancelled?.()) return
        const single: Op = { kind: op.kind, rows: [row] }
        try {
          if (session.savepoints) await session.savepoint(rowSavepointName)
          const results = await this.run(single)
          if (session.savepoints) await session.release(rowSavepointName)
          this.count(single, results)
        } catch (e) {
          if (session.savepoints) await session.rollbackTo(rowSavepointName)
          const rowError: RowError = { rowNumber: row.rowNumber, message: errorMessage(e) }
          counts.failed++
          this.o.onRowError(rowError)
          if (errorMode === 'stop') throw new ImportStopError(rowError)
        }
      }
    }
  }
}

/** The id of the result field called `name` (drivers key rows by id). */
function fieldId(result: NgQueryResult | undefined, name: string): string {
  const field = (result?.fields || []).find((f) => f.name === name || f.id === name)
  return field ? field.id : name
}

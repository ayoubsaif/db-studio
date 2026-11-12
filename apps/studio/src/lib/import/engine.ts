import { Knex } from 'knex'
import { Dialect } from '@shared/lib/dialects/models'
import { ExtendedTableColumn, PrimaryKeyColumn, TableIndex } from '@/lib/db/models'
import { batches, maxBatchSize } from './batcher'
import { ConvertedRow, createConverter, RowConverter } from './converter'
import { readFileRows } from './readers'
import { ImportSession } from './session'
import { importSupport, isModeEnabled } from './support'
import {
  ColumnMapping, emptyCounts, ImportCounts, ImportMode, ImportOptions, ImportProgress, ImportRequest,
  ImportStatus, ImportSummary, ImportUpsertSpec, InsertingModes, KeyedModes, maxReportedErrors, RowError, TargetColumn,
} from './types'
import { errorMessage, ImportStopError, ImportWriter } from './writer'

/** What the engine needs from a database client. */
export interface ImportClient {
  knex: Knex
  listTableColumns(table: string, schema?: string): Promise<ExtendedTableColumn[]>
  getPrimaryKeys?(table: string, schema?: string): Promise<PrimaryKeyColumn[]>
  createImportSession(useTransaction: boolean): Promise<ImportSession>
  /** optional native upsert, see BasicDatabaseClient.importUpsertSql */
  importUpsertSql?(spec: ImportUpsertSpec): string | null
  listTableIndexes?(table: string, schema?: string): Promise<TableIndex[]>
  readOnlyMode?: boolean
}

export function toTargetColumns(columns: ExtendedTableColumn[]): TargetColumn[] {
  return columns.map((c) => {
    const extra = `${c.extra || ''} ${c.defaultValue ?? ''}`.toLowerCase()
    return {
      name: c.columnName,
      dataType: c.dataType,
      nullable: c.nullable !== false,
      hasDefault: !!c.hasDefault || (c.defaultValue !== null && c.defaultValue !== undefined && c.defaultValue !== '') ||
        /auto_increment|autoincrement|identity|nextval|serial/.test(extra),
      generated: !!c.generated,
    }
  })
}

/** Problems that block running the import. Returns an empty list when it can run. */
export function validateImport(dialect: Dialect, mappings: ColumnMapping[], columns: TargetColumn[], options: ImportOptions): string[] {
  const problems: string[] = []
  const mapped = mappings.filter((m) => m.tableColumn).map((m) => m.tableColumn)
  if (!mapped.length) problems.push('Map at least one file column to a table column.')
  const duplicates = mapped.filter((c, i) => mapped.indexOf(c) !== i)
  if (duplicates.length) problems.push(`Each table column can be mapped once: ${[...new Set(duplicates)].join(', ')}.`)
  if (!isModeEnabled(dialect, options.mode)) problems.push(`This database can't import in ${modeTitle(options.mode)} mode.`)
  if (KeyedModes.includes(options.mode)) {
    if (!options.keyColumns.length) problems.push(`${modeTitle(options.mode)} needs at least one key column to match rows.`)
    const unmapped = options.keyColumns.filter((k) => !mapped.includes(k))
    if (unmapped.length) problems.push(`Key columns must be mapped: ${unmapped.join(', ')}.`)
  }
  if (options.mode === 'update' || options.mode === 'appendUpdate') {
    if (!mapped.some((c) => !options.keyColumns.includes(c))) {
      problems.push('Map at least one column besides the key columns, so there is something to update.')
    }
  }
  return problems
}

/** Warnings that don't block running, for example required columns left unmapped. */
export function importWarnings(dialect: Dialect, mappings: ColumnMapping[], columns: TargetColumn[], options: ImportOptions): string[] {
  const warnings = [...importSupport(dialect).warnings]
  const mapped = new Set(mappings.filter((m) => m.tableColumn).map((m) => m.tableColumn))
  if (InsertingModes.includes(options.mode)) {
    const required = columns.filter((c) => !c.nullable && !c.hasDefault && !c.generated && !mapped.has(c.name))
    if (required.length) {
      warnings.push(`These columns can't be empty and have no default, but aren't mapped: ${required.map((c) => c.name).join(', ')}. Inserted rows will fail.`)
    }
  }
  if (!options.useTransaction && importSupport(dialect).transactions) {
    warnings.push("The import doesn't run in a transaction, so rows written before an error stay in the table.")
  }
  return warnings
}

const titles: Record<ImportMode, string> = {
  append: 'Append',
  update: 'Update',
  appendUpdate: 'Append/Update',
  appendNoUpdate: 'Append without update',
  delete: 'Delete',
  copy: 'Copy',
}

export function modeTitle(mode: ImportMode) {
  return titles[mode]
}

/** Maps file columns to table columns by case-insensitive name; unmatched file columns are skipped. */
export function autoMap(fileColumns: string[], tableColumns: string[]): ColumnMapping[] {
  const byLower = new Map<string, string>()
  for (const c of tableColumns) if (!byLower.has(c.toLowerCase())) byLower.set(c.toLowerCase(), c)
  const used = new Set<string>()
  return fileColumns.map((fileColumn, fileIndex) => {
    const match = byLower.get(fileColumn.trim().toLowerCase())
    const tableColumn = match && !used.has(match) ? match : null
    if (tableColumn) used.add(tableColumn)
    return { fileIndex, fileColumn, tableColumn }
  })
}

export interface PreviewRow {
  rowNumber: number
  values: Record<string, any>
  errors: RowError[]
}

/** The first rows of the file as they'll be written, with conversion errors. */
export async function previewImport(request: ImportRequest, columns: TargetColumn[], limit = 50): Promise<PreviewRow[]> {
  const converter = createConverter(request.mappings, columns, request.options)
  const rows: PreviewRow[] = []
  for await (const fileRow of readFileRows(request.filePath, request.parse)) {
    const { row, errors } = converter.convert(fileRow)
    const values = row ? row.values : Object.fromEntries(converter.columns.map((c) => {
      const mapping = request.mappings.find((m) => m.tableColumn === c)
      return [c, fileRow.values[mapping.fileIndex] ?? null]
    }))
    rows.push({ rowNumber: fileRow.rowNumber, values, errors })
    if (rows.length >= limit) break
  }
  return rows
}

class CancelledError extends Error {
  constructor() { super('The import was cancelled') }
}

/** One run of an import. Create it, subscribe to progress, then call run(). */
export class ImportJob {
  status: ImportStatus = 'idle'
  counts: ImportCounts = emptyCounts()
  private errors: RowError[] = []
  private cancelled = false
  private listeners: ((progress: ImportProgress) => void)[] = []

  constructor(private client: ImportClient, private dialect: Dialect, readonly request: ImportRequest) {}

  onProgress(listener: (progress: ImportProgress) => void) {
    this.listeners.push(listener)
  }

  cancel() {
    this.cancelled = true
  }

  get progress(): ImportProgress {
    return { ...this.counts, status: this.status }
  }

  private emit() {
    const progress = this.progress
    this.listeners.forEach((l) => l(progress))
  }

  private recordError(error: RowError) {
    if (this.errors.length < maxReportedErrors) this.errors.push(error)
  }

  /**
   * The native upsert for this import, or undefined to use the generic path.
   * Only used when the key columns are exactly a primary key or unique index,
   * because that's what ON CONFLICT and friends match on.
   */
  private async nativeUpsert(columns: string[]): Promise<((rows: Record<string, any>[]) => string | null) | undefined> {
    const { options, target } = this.request
    if (options.nativeUpsert === false || !this.client.importUpsertSql || !this.client.listTableIndexes) return undefined
    if (options.mode !== 'appendUpdate' && options.mode !== 'appendNoUpdate') return undefined
    const mode = options.mode
    const spec = (rows: Record<string, any>[]): ImportUpsertSpec => ({ target, mode, keyColumns: options.keyColumns, columns, rows })
    if (this.client.importUpsertSql(spec([Object.fromEntries(columns.map((c) => [c, null]))])) === null) return undefined
    const indexes = await this.client.listTableIndexes(target.table, target.schema || undefined).catch(() => [] as TableIndex[])
    const keys = [...options.keyColumns].sort().join(' ')
    const matches = indexes.some((index) => (index.unique || index.primary) &&
      index.columns.map((c) => c.name).sort().join(' ') === keys)
    return matches ? (rows) => this.client.importUpsertSql(spec(rows)) : undefined
  }

  async run(): Promise<ImportSummary> {
    const started = Date.now()
    const { request } = this
    const { options, target } = request
    const support = importSupport(this.dialect)
    let session: ImportSession | null = null
    let fatal: string | null = null
    let rolledBack = false
    let warnings: string[] = []
    let usedNativeUpsert = false
    this.status = 'running'
    this.emit()

    try {
      if (!this.client.knex) throw new Error("Importing isn't available for this database.")
      if (this.client.readOnlyMode) throw new Error('The connection is read-only.')
      const columns = toTargetColumns(await this.client.listTableColumns(target.table, target.schema || undefined))
      const problems = validateImport(this.dialect, request.mappings, columns, options)
      if (problems.length) throw new Error(problems.join(' '))
      warnings = importWarnings(this.dialect, request.mappings, columns, options)
      const converter: RowConverter = createConverter(request.mappings, columns, options)
      const upsertSql = await this.nativeUpsert(converter.columns)
      usedNativeUpsert = !!upsertSql

      session = await this.client.createImportSession(options.useTransaction && support.transactions)
      const writer = new ImportWriter({
        session,
        knex: this.client.knex,
        dialect: this.dialect,
        target,
        mode: options.mode,
        keyColumns: options.keyColumns,
        columns: converter.columns,
        errorMode: options.errorMode,
        counts: this.counts,
        onRowError: (e) => this.recordError(e),
        isCancelled: () => this.cancelled,
        upsertSql,
      })
      const size = maxBatchSize(this.dialect, converter.columns.length, options.batchSize)

      await session.begin()
      if (options.mode === 'copy') await writer.emptyTable()

      for await (const batch of batches(readFileRows(request.filePath, request.parse), size)) {
        if (this.cancelled) throw new CancelledError()
        const good: ConvertedRow[] = []
        for (const fileRow of batch) {
          this.counts.read++
          const { row, errors } = converter.convert(fileRow)
          if (row) {
            good.push(row)
            continue
          }
          this.counts.failed++
          errors.forEach((e) => this.recordError(e))
          if (options.errorMode === 'stop') throw new ImportStopError(errors[0])
        }
        if (good.length) await writer.write(good)
        if (this.cancelled) throw new CancelledError()
        this.emit()
      }

      await session.commit()
      this.status = 'completed'
    } catch (e) {
      this.status = e instanceof CancelledError ? 'cancelled' : 'failed'
      fatal = e instanceof CancelledError ? null : errorMessage(e)
      if (session?.transactional) {
        try {
          await session.rollback()
          rolledBack = true
        } catch (rollbackError) {
          fatal = `${fatal || 'Cancelled'}. Rolling back also failed: ${errorMessage(rollbackError)}`
        }
      }
    } finally {
      try {
        await session?.close()
      } catch (_e) {
        // the connection is gone; nothing left to clean up
      }
    }

    if (rolledBack) {
      // nothing from the file stayed in the table
      this.counts.inserted = this.counts.updated = this.counts.deleted = 0
    }
    this.emit()
    return {
      ...this.counts,
      status: this.status,
      errors: this.errors,
      error: fatal,
      rolledBack,
      warnings,
      nativeUpsert: usedNativeUpsert,
      elapsedMs: Date.now() - started,
    }
  }
}

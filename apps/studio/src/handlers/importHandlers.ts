import rawLog from 'electron-log'
import { Dialect, dialectFor } from '@shared/lib/dialects/models'
import {
  autoMap, ImportJob, importWarnings, previewImport, PreviewRow, toTargetColumns, validateImport,
} from '@/lib/import/engine'
import { sampleFile } from '@/lib/import/readers'
import { DialectImportSupport, importSupport } from '@/lib/import/support'
import { ColumnMapping, FileSample, ImportRequest, ImportSummary, ImportTarget, ParseOptions, TargetColumn } from '@/lib/import/types'
import { uuidv4 } from '@/lib/uuid'
import { checkConnection, state } from './handlerState'

const log = rawLog.scope('ImportHandler')

export interface ImportRecord {
  job: ImportJob
  summary: ImportSummary | null
}

export interface ImportCheck {
  problems: string[]
  warnings: string[]
}

export interface ImportTableInfo {
  columns: TargetColumn[]
  primaryKey: string[]
  /** null when counting failed, for example on very large tables */
  rowCount: number | null
}

function dialect(sId: string): Dialect {
  const d = dialectFor(state(sId).connection.connectionType)
  if (!d) throw new Error(`Importing isn't available for ${state(sId).connection.connectionType}`)
  return d
}

async function tableColumns(sId: string, target: ImportTarget): Promise<TargetColumn[]> {
  return toTargetColumns(await state(sId).connection.listTableColumns(target.table, target.schema || undefined))
}

function getImport(sId: string, id: string): ImportRecord {
  const record = state(sId).imports.get(id)
  if (!record) throw new Error('Import not found')
  return record
}

export interface IImportHandlers {
  'import/support': ({ sId }: { sId: string }) => Promise<DialectImportSupport>,
  'import/sample': ({ filePath, parse, limit }: { filePath: string, parse: ParseOptions, limit?: number, sId: string }) => Promise<FileSample>,
  'import/table': ({ target, sId }: { target: ImportTarget, sId: string }) => Promise<ImportTableInfo>,
  'import/autoMap': ({ fileColumns, tableColumns }: { fileColumns: string[], tableColumns: string[], sId: string }) => Promise<ColumnMapping[]>,
  'import/check': ({ request, sId }: { request: ImportRequest, sId: string }) => Promise<ImportCheck>,
  'import/preview': ({ request, limit, sId }: { request: ImportRequest, limit?: number, sId: string }) => Promise<PreviewRow[]>,
  'import/start': ({ request, sId }: { request: ImportRequest, sId: string }) => Promise<string>,
  'import/result': ({ id, sId }: { id: string, sId: string }) => Promise<ImportSummary | null>,
  'import/cancel': ({ id, sId }: { id: string, sId: string }) => Promise<void>,
  'import/remove': ({ id, sId }: { id: string, sId: string }) => Promise<void>,
}

export const ImportHandlers: IImportHandlers = {
  'import/support': async function({ sId }) {
    checkConnection(sId)
    return importSupport(dialect(sId))
  },

  'import/sample': async function({ filePath, parse, limit }) {
    return sampleFile(filePath, parse, limit || 20)
  },

  'import/table': async function({ target, sId }) {
    checkConnection(sId)
    const connection = state(sId).connection
    const columns = await tableColumns(sId, target)
    const keys = await connection.getPrimaryKeys(target.table, target.schema || undefined).catch(() => [])
    const rowCount = await connection.getTableLength(target.table, target.schema || undefined).catch(() => null)
    return {
      columns,
      primaryKey: [...keys].sort((a, b) => a.position - b.position).map((k) => k.columnName),
      rowCount: rowCount === null || rowCount === undefined ? null : Number(rowCount),
    }
  },

  'import/autoMap': async function({ fileColumns, tableColumns }) {
    return autoMap(fileColumns, tableColumns)
  },

  'import/check': async function({ request, sId }) {
    checkConnection(sId)
    const d = dialect(sId)
    const columns = await tableColumns(sId, request.target)
    const problems = validateImport(d, request.mappings, columns, request.options)
    if (state(sId).connection.readOnlyMode) problems.unshift('The connection is read-only.')
    return { problems, warnings: importWarnings(d, request.mappings, columns, request.options) }
  },

  'import/preview': async function({ request, limit, sId }) {
    checkConnection(sId)
    return previewImport(request, await tableColumns(sId, request.target), limit || 50)
  },

  'import/start': async function({ request, sId }) {
    checkConnection(sId)
    if (state(sId).connection.readOnlyMode) throw new Error('The connection is read-only.')
    const id = uuidv4()
    const job = new ImportJob(state(sId).connection, dialect(sId), request)
    const record: ImportRecord = { job, summary: null }
    state(sId).imports.set(id, record)

    // send progress at most every 250ms
    let last = 0
    job.onProgress((progress) => {
      const now = Date.now()
      if (progress.status === 'running' && now - last < 250) return
      last = now
      state(sId)?.port?.postMessage({ type: `onImportProgress/${id}`, input: progress })
    })

    job.run().then((summary) => {
      record.summary = summary
      state(sId)?.port?.postMessage({ type: `onImportDone/${id}`, input: summary })
    }, (e) => {
      log.error('import crashed', e)
      record.summary = {
        ...job.counts, status: 'failed', errors: [], error: e?.message || String(e),
        rolledBack: false, warnings: [], elapsedMs: 0,
      }
      state(sId)?.port?.postMessage({ type: `onImportDone/${id}`, input: record.summary })
    })
    return id
  },

  'import/result': async function({ id, sId }) {
    return getImport(sId, id).summary
  },

  'import/cancel': async function({ id, sId }) {
    getImport(sId, id).job.cancel()
  },

  'import/remove': async function({ id, sId }) {
    state(sId).imports.delete(id)
  },
}

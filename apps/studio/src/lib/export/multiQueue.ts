// Runs a multi-table export one table at a time. Kept free of Node and Vue
// imports so the renderer can use it and tests can drive it with fakes.
import { TableOrView } from '../db/models'
import {
  ExportProgress, ExportStatus, MultiExportRequest, MultiExportTableResult, StartExportOptions
} from './models'

/** The subset of the utility connection the queue needs. */
export interface MultiExportDeps {
  send: (name: string, args: any) => Promise<any>
  addListener: (type: string, listener: (p: ExportProgress) => void) => string
  removeListener: (id: string) => void
  /** called when a table starts and whenever its row count changes */
  onProgress?: (position: number, total: number, name: string, rows: number) => void
}

export interface MultiExportJob {
  /** stops the current table and skips the rest */
  cancel: () => Promise<void>
  done: Promise<MultiExportResult>
}

export interface MultiExportResult {
  cancelled: boolean
  results: MultiExportTableResult[]
}

interface ExportResultPayload {
  status: ExportStatus
  countExported: number
  error: string | null
  warnings: string[]
}

export function tableDisplayName(table: Pick<TableOrView, 'name' | 'schema'>): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name
}

export function startMultiExport(request: MultiExportRequest, deps: MultiExportDeps): MultiExportJob {
  const state = { cancelled: false, currentId: null as string | null }

  const cancel = async () => {
    state.cancelled = true
    if (state.currentId) await deps.send('export/cancel', { id: state.currentId })
  }

  const done = (async (): Promise<MultiExportResult> => {
    const total = request.tables.length
    const results: MultiExportTableResult[] = []
    const taken: string[] = []

    for (const [index, table] of request.tables.entries()) {
      const name = tableDisplayName(table)
      const position = index + 1
      if (state.cancelled) {
        results.push({ name, outcome: 'not started', rows: 0 })
        continue
      }
      deps.onProgress?.(position, total, name, 0)
      let id: string | null = null
      let listenerId: string | null = null
      try {
        // plain object: reactive store objects don't survive the trip to the utility process
        const plainTable = { name: table.name, schema: table.schema, entityType: table.entityType }
        const filePath: string | null = await deps.send('export/resolveTarget', {
          options: {
            directory: request.directory,
            table: plainTable,
            extension: request.exporter,
            existing: request.existing,
            taken: [...taken],
          }
        })
        if (!filePath) {
          results.push({ name, outcome: 'skipped', rows: 0, message: 'A file with this name already exists' })
          continue
        }
        taken.push(filePath)

        const options: StartExportOptions = {
          table: plainTable as TableOrView,
          filters: [],
          exporter: request.exporter,
          filePath,
          options: request.options,
          outputOptions: request.outputOptions,
        }
        id = await deps.send('export/add', { options })
        state.currentId = id
        listenerId = deps.addListener(`onExportProgress/${id}`, (p) => {
          deps.onProgress?.(position, total, name, p.countExported)
        })
        // a cancel that arrived while the export was being set up
        if (state.cancelled) await deps.send('export/cancel', { id })
        await deps.send('export/start', { id })

        const result: ExportResultPayload = await deps.send('export/result', { id })
        if (result.status === ExportStatus.Completed) {
          results.push({
            name, outcome: 'exported', rows: result.countExported, filePath,
            message: result.warnings?.length ? result.warnings.join(' ') : undefined,
          })
        } else if (result.status === ExportStatus.Aborted) {
          results.push({
            name, outcome: 'cancelled', rows: result.countExported,
            message: request.options.deleteOnAbort ? 'Partial file deleted' : 'Partial file kept',
          })
        } else {
          results.push({ name, outcome: 'failed', rows: result.countExported, message: result.error || 'Unknown error' })
        }
      } catch (e) {
        results.push({ name, outcome: 'failed', rows: 0, message: e?.message || String(e) })
      } finally {
        if (listenerId) deps.removeListener(listenerId)
        if (id) await deps.send('export/remove', { id }).catch(() => undefined)
        state.currentId = null
      }
    }
    return { cancelled: state.cancelled, results }
  })()

  return { cancel, done }
}

/** One-line summary, eg "Exported 4 of 5 tables (1,234 rows). 1 failed." */
export function summarizeMultiExport({ cancelled, results }: MultiExportResult): { headline: string, hasProblems: boolean } {
  const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length
  const exported = count('exported')
  const rows = results.reduce((sum, r) => sum + (r.outcome === 'exported' ? r.rows : 0), 0)
  const notExported = count('cancelled') + count('not started')
  const problems = [
    count('failed') && `${count('failed')} failed`,
    count('skipped') && `${count('skipped')} skipped`,
    notExported && `${notExported} not exported`,
  ].filter(Boolean)
  const headline = [
    cancelled ? 'Export cancelled.' : '',
    `Exported ${exported} of ${results.length} ${results.length === 1 ? 'table' : 'tables'} (${rows.toLocaleString()} rows).`,
    problems.length ? `${problems.join(', ')}.` : '',
  ].filter(Boolean).join(' ')
  return { headline, hasProblems: problems.length > 0 || cancelled }
}

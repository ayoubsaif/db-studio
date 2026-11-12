import { ExportStatus, MultiExportRequest } from '@/lib/export/models'
import { startMultiExport, summarizeMultiExport } from '@/lib/export/multiQueue'

type Behavior = { rows?: number, fail?: string, skip?: boolean, throws?: string }

/**
 * A stand-in for the utility process. Each table name maps to how its export
 * should behave; `onStart` lets a test act while a table is exporting.
 */
function fakeUtility(behavior: Record<string, Behavior>, onStart?: (name: string, cancelled: () => boolean) => Promise<void>) {
  const calls: { name: string, args: any }[] = []
  const exports = new Map<string, { table: string, status: ExportStatus, rows: number, error: string | null }>()
  const listeners = new Map<string, { type: string, fn: (p: any) => void }>()
  let nextId = 1

  const send = async (name: string, args: any) => {
    calls.push({ name, args })
    switch (name) {
      case 'export/resolveTarget': {
        const b = behavior[args.options.table.name] || {}
        return b.skip ? null : `${args.options.directory}/${args.options.table.name}.${args.options.extension}`
      }
      case 'export/add': {
        const id = `e${nextId++}`
        const table = args.options.table.name
        if (behavior[table]?.throws) throw new Error(behavior[table].throws)
        exports.set(id, { table, status: ExportStatus.Idle, rows: 0, error: null })
        return id
      }
      case 'export/start': {
        const exp = exports.get(args.id)!
        const b = behavior[exp.table] || {}
        if (exp.status === ExportStatus.Aborted) return
        exp.status = ExportStatus.Exporting
        await onStart?.(exp.table, () => exp.status === ExportStatus.Aborted)
        if (exp.status === ExportStatus.Aborted) return
        exp.rows = b.rows ?? 0
        listeners.forEach((l) => l.type === `onExportProgress/${args.id}` && l.fn({ countExported: exp.rows }))
        if (b.fail) {
          exp.status = ExportStatus.Error
          exp.error = b.fail
        } else {
          exp.status = ExportStatus.Completed
        }
        return
      }
      case 'export/cancel':
        exports.get(args.id)!.status = ExportStatus.Aborted
        return
      case 'export/result': {
        const exp = exports.get(args.id)!
        return { status: exp.status, countExported: exp.rows, error: exp.error, warnings: [] }
      }
      case 'export/remove':
        exports.delete(args.id)
        return
      default:
        throw new Error(`unexpected call ${name}`)
    }
  }

  return {
    calls,
    exports,
    listeners,
    deps: {
      send,
      addListener: (type: string, fn: (p: any) => void) => {
        const id = `l${listeners.size + 1}`
        listeners.set(id, { type, fn })
        return id
      },
      removeListener: (id: string) => { listeners.delete(id) },
    },
  }
}

function request(names: string[], overrides: Partial<MultiExportRequest> = {}): MultiExportRequest {
  return {
    tables: names.map((name) => ({ name, schema: 'public', entityType: 'table' } as any)),
    directory: '/out',
    existing: 'number',
    exporter: 'csv',
    options: { chunkSize: 100, deleteOnAbort: true, includeFilter: false },
    outputOptions: { header: true, delimiter: ',' },
    ...overrides,
  }
}

describe('multi-table export queue', () => {
  it('exports every table to its own file, in order', async () => {
    const util = fakeUtility({ a: { rows: 3 }, b: { rows: 5 } })
    const { done } = startMultiExport(request(['a', 'b']), util.deps)
    const { cancelled, results } = await done

    expect(cancelled).toBe(false)
    expect(results).toEqual([
      { name: 'public.a', outcome: 'exported', rows: 3, filePath: '/out/a.csv', message: undefined },
      { name: 'public.b', outcome: 'exported', rows: 5, filePath: '/out/b.csv', message: undefined },
    ])
    // exports are cleaned up and listeners removed
    expect(util.exports.size).toBe(0)
    expect(util.listeners.size).toBe(0)
  })

  it('passes paths already used in the run to the next table', async () => {
    const util = fakeUtility({})
    await startMultiExport(request(['a', 'b']), util.deps).done
    const resolves = util.calls.filter((c) => c.name === 'export/resolveTarget')
    expect(resolves[0].args.options.taken).toEqual([])
    expect(resolves[1].args.options.taken).toEqual(['/out/a.csv'])
  })

  it('sends plain table objects with no filters', async () => {
    const util = fakeUtility({})
    const req = request(['a'])
    ;(req.tables[0] as any).columns = [{ name: 'x' }]
    await startMultiExport(req, util.deps).done
    const add = util.calls.find((c) => c.name === 'export/add')!
    expect(add.args.options.table).toEqual({ name: 'a', schema: 'public', entityType: 'table' })
    expect(add.args.options.filters).toEqual([])
  })

  it('keeps going when one table fails and reports the error', async () => {
    const util = fakeUtility({ a: { rows: 1 }, b: { fail: 'permission denied for table b' }, c: { rows: 2 } })
    const { results } = await startMultiExport(request(['a', 'b', 'c']), util.deps).done
    expect(results.map((r) => r.outcome)).toEqual(['exported', 'failed', 'exported'])
    expect(results[1].message).toBe('permission denied for table b')
  })

  it('reports a table that could not even be set up as failed', async () => {
    const util = fakeUtility({ a: { throws: 'connection lost' }, b: { rows: 1 } })
    const { results } = await startMultiExport(request(['a', 'b']), util.deps).done
    expect(results[0]).toEqual({ name: 'public.a', outcome: 'failed', rows: 0, message: 'connection lost' })
    expect(results[1].outcome).toBe('exported')
  })

  it('skips tables whose file already exists when asked', async () => {
    const util = fakeUtility({ a: { skip: true }, b: { rows: 1 } })
    const { results } = await startMultiExport(request(['a', 'b'], { existing: 'skip' }), util.deps).done
    expect(results[0]).toEqual({ name: 'public.a', outcome: 'skipped', rows: 0, message: 'A file with this name already exists' })
    expect(util.calls.filter((c) => c.name === 'export/add')).toHaveLength(1)
  })

  it('reports progress per table', async () => {
    const util = fakeUtility({ a: { rows: 7 } })
    const progress: any[] = []
    await startMultiExport(request(['a']), { ...util.deps, onProgress: (...args) => progress.push(args) }).done
    expect(progress).toEqual([[1, 1, 'public.a', 0], [1, 1, 'public.a', 7]])
  })

  it('cancel stops the current table and skips the rest', async () => {
    let job: ReturnType<typeof startMultiExport>
    const util = fakeUtility({ a: { rows: 1 }, b: { rows: 1 }, c: { rows: 1 }, d: { rows: 1 } }, async (name) => {
      if (name === 'c') await job.cancel()
    })
    job = startMultiExport(request(['a', 'b', 'c', 'd']), util.deps)
    const { cancelled, results } = await job.done

    expect(cancelled).toBe(true)
    expect(results.map((r) => r.outcome)).toEqual(['exported', 'exported', 'cancelled', 'not started'])
    expect(results[2].message).toBe('Partial file deleted')
    expect(util.calls.filter((c) => c.name === 'export/add')).toHaveLength(3)
  })

  it('cancel between tables starts no more exports', async () => {
    const util = fakeUtility({ a: { rows: 1 }, b: { rows: 1 } })
    const job = startMultiExport(request(['a', 'b']), util.deps)
    await job.cancel()
    const { results } = await job.done
    // the first table had already been picked up when cancel arrived
    expect(results[1].outcome).toBe('not started')
    expect(util.calls.filter((c) => c.name === 'export/add').length).toBeLessThanOrEqual(1)
  })
})

describe('multi-table export summary', () => {
  it('summarizes a clean run', () => {
    const { headline, hasProblems } = summarizeMultiExport({
      cancelled: false,
      results: [
        { name: 'a', outcome: 'exported', rows: 2 },
        { name: 'b', outcome: 'exported', rows: 3 },
      ],
    })
    expect(headline).toBe('Exported 2 of 2 tables (5 rows).')
    expect(hasProblems).toBe(false)
  })

  it('lists failures, skips and cancellation', () => {
    const { headline, hasProblems } = summarizeMultiExport({
      cancelled: true,
      results: [
        { name: 'a', outcome: 'exported', rows: 4 },
        { name: 'b', outcome: 'failed', rows: 0 },
        { name: 'c', outcome: 'skipped', rows: 0 },
        { name: 'd', outcome: 'cancelled', rows: 9 },
        { name: 'e', outcome: 'not started', rows: 0 },
      ],
    })
    expect(headline).toBe('Export cancelled. Exported 1 of 5 tables (4 rows). 1 failed, 1 skipped, 2 not exported.')
    expect(hasProblems).toBe(true)
  })
})

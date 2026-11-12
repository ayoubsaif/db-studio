import fs from 'fs'
import os from 'os'
import path from 'path'
import { createServer } from '@/lib/db'
import { ImportHandlers } from '@/handlers/importHandlers'
import { newState, removeState, state } from '@/handlers/handlerState'
import { ImportRequest } from '@/lib/import/types'

const sId = 'import-handler-test'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-import-handler-'))
const messages: { type: string, input: any }[] = []

function waitFor(type: string): Promise<any> {
  return new Promise((resolve) => {
    const check = () => {
      const m = messages.find((x) => x.type === type)
      if (m) resolve(m.input)
      else setTimeout(check, 20)
    }
    check()
  })
}

beforeAll(async () => {
  newState(sId)
  const server = createServer({ client: 'sqlite' } as any)
  const connection = server.createConnection(path.join(dir, 'h.db'))
  await connection.connect()
  state(sId).connection = connection as any
  state(sId).port = { postMessage: (m) => messages.push(m) } as any
  await connection.executeQuery('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, price NUMERIC)')
  await connection.executeQuery("INSERT INTO items VALUES (1, 'one', 1.5)")
})

afterAll(async () => {
  await state(sId).connection.disconnect()
  removeState(sId)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_e) {
    // Windows may still hold the database file
  }
})

describe('import handlers', () => {
  const filePath = path.join(dir, 'items.csv')
  fs.writeFileSync(filePath, 'ID;Label;Price;Extra\n1;uno;2,5;x\n2;dos;3,25;y\n3;;4;z\n')

  const baseRequest = (): ImportRequest => ({
    filePath,
    parse: { format: 'csv', headerRow: 1, csv: { delimiter: ';' } },
    target: { table: 'items' },
    mappings: [],
    options: {
      mode: 'appendUpdate', keyColumns: ['id'], useTransaction: true, batchSize: 500, errorMode: 'continue',
      decimalSeparator: ',', dateFormat: 'YYYY-MM-DD', emptyAsNull: true,
    },
  })

  it('samples the file, maps columns, previews and runs a CSV import end to end', async () => {
    const sample = await ImportHandlers['import/sample']({ filePath, parse: baseRequest().parse, sId })
    expect(sample.columns).toEqual(['ID', 'Label', 'Price', 'Extra'])

    const info = await ImportHandlers['import/table']({ target: { table: 'items' }, sId })
    expect(info.primaryKey).toEqual(['id'])
    expect(info.rowCount).toBe(1)
    expect(info.columns.find((c) => c.name === 'label')).toMatchObject({ nullable: false, hasDefault: false })

    const mappings = await ImportHandlers['import/autoMap']({ fileColumns: sample.columns, tableColumns: info.columns.map((c) => c.name), sId })
    expect(mappings.map((m) => m.tableColumn)).toEqual(['id', 'label', 'price', null])

    const request = { ...baseRequest(), mappings }
    expect(await ImportHandlers['import/check']({ request, sId })).toEqual({ problems: [], warnings: [] })

    const preview = await ImportHandlers['import/preview']({ request, sId })
    expect(preview.map((r) => r.values)).toEqual([
      { id: 1, label: 'uno', price: 2.5 }, { id: 2, label: 'dos', price: 3.25 }, { id: 3, label: null, price: 4 },
    ])

    const id = await ImportHandlers['import/start']({ request, sId })
    const summary = await waitFor(`onImportDone/${id}`)
    // row 4 has an empty label, which the table doesn't allow
    expect(summary).toMatchObject({ status: 'completed', updated: 1, inserted: 1, failed: 1 })
    expect(summary.errors[0].rowNumber).toBe(4)
    expect(summary.errors[0].message).toMatch(/NOT NULL/)
    expect(await ImportHandlers['import/result']({ id, sId })).toEqual(summary)
    expect(messages.some((m) => m.type === `onImportProgress/${id}`)).toBe(true)

    const [rows] = await state(sId).connection.executeQuery('SELECT id, label, price FROM items ORDER BY id')
    expect(rows.rows.map((r) => [Number(r.id), r.label, Number(r.price)])).toEqual([[1, 'uno', 2.5], [2, 'dos', 3.25]])

    await ImportHandlers['import/remove']({ id, sId })
    await expect(ImportHandlers['import/result']({ id, sId })).rejects.toThrow(/not found/)
  })

  it('reports problems before running', async () => {
    const request = { ...baseRequest(), options: { ...baseRequest().options, mode: 'update' as const, keyColumns: [] } }
    request.mappings = [{ fileIndex: 0, fileColumn: 'ID', tableColumn: 'id' }]
    const check = await ImportHandlers['import/check']({ request, sId })
    expect(check.problems.join(' ')).toMatch(/needs at least one key column/)
  })

  it('reports the database support for the connection', async () => {
    const support = await ImportHandlers['import/support']({ sId })
    expect(support.transactions).toBe(true)
    expect(support.modes.every((m) => m.enabled)).toBe(true)
  })
})

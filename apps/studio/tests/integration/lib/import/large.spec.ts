import fs from 'fs'
import os from 'os'
import path from 'path'
import * as ExcelJS from 'exceljs'
import { createServer } from '@/lib/db'
import { autoMap, ImportJob } from '@/lib/import/engine'
import { ImportRequest } from '@/lib/import/types'
import rawLog from 'electron-log'

/**
 * Imports a 1,000,000-row CSV and a 200,000-row XLSX into SQLite and checks
 * memory stays flat. Slow, so it only runs with IMPORT_TEST_LARGE=1, and it
 * needs --expose-gc:
 *   IMPORT_TEST_LARGE=1 electron --expose-gc jest.js --config ./jest.integration.config.js large
 */
const describeIf = process.env.IMPORT_TEST_LARGE ? describe : describe.skip
const mb = (n: number) => Math.round(n / 1024 / 1024)

describeIf('large imports', () => {
  jest.setTimeout(30 * 60 * 1000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-import-large-'))
  let conn: any

  beforeAll(async () => {
    // the test setup logs every query at debug level, and Jest keeps captured logs in memory
    rawLog.transports.console.level = false
    rawLog.transports.file.level = false
    conn = createServer({ client: 'sqlite' } as any).createConnection(path.join(dir, 'large.db'))
    await conn.connect()
  })

  afterAll(async () => {
    await conn?.disconnect()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_e) { /* file may be locked */ }
  })

  async function measure(request: ImportRequest, total: number) {
    await conn.executeQuery('DROP TABLE IF EXISTS big; CREATE TABLE big (id INTEGER PRIMARY KEY, name TEXT, amount NUMERIC, day TEXT)')
    const job = new ImportJob(conn, 'sqlite', request)
    // V8 collects lazily, so compare what is still held after a full collection
    const gc = (global as any).gc
    if (!gc) throw new Error('Run with electron --expose-gc so retained memory can be measured')
    const retained = () => {
      gc()
      const m = process.memoryUsage()
      return { rss: m.rss, heap: m.heapUsed }
    }
    let quarter = null
    let end = null
    let peak = 0
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 200)
    job.onProgress((p) => {
      if (!quarter && p.read >= total / 4) quarter = retained()
      if (!end && p.read >= total * 0.95) end = retained()
    })
    const started = Date.now()
    const summary = await job.run()
    clearInterval(timer)
    const [count] = await conn.executeQuery('SELECT count(*) AS n FROM big')
    const result = {
      status: summary.status, inserted: summary.inserted, rowsInTable: Number(count.rows[0].n),
      seconds: Math.round((Date.now() - started) / 1000),
      retainedAtQuarterMb: { rss: mb(quarter.rss), heap: mb(quarter.heap) },
      retainedNearEndMb: { rss: mb(end.rss), heap: mb(end.heap) },
      heapGrowthMb: mb(end.heap - quarter.heap),
      peakRssMb: mb(peak),
    }
    console.log(JSON.stringify(result))
    return result
  }

  it('imports a 1,000,000-row CSV with flat memory', async () => {
    const total = 1_000_000
    const file = path.join(dir, 'big.csv')
    const out = fs.createWriteStream(file)
    out.write('id,name,amount,day\n')
    for (let i = 1; i <= total; i++) {
      if (!out.write(`${i},"name, number ${i}",${(i % 1000) / 4},2024-01-${String((i % 28) + 1).padStart(2, '0')}\n`)) {
        await new Promise((r) => out.once('drain', r))
      }
    }
    await new Promise((r) => out.end(r))

    const r = await measure({
      filePath: file,
      parse: { format: 'csv', headerRow: 1, csv: {} },
      target: { table: 'big' },
      mappings: autoMap(['id', 'name', 'amount', 'day'], ['id', 'name', 'amount', 'day']),
      options: {
        mode: 'append', keyColumns: [], useTransaction: true, batchSize: 1000, errorMode: 'stop',
        decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', emptyAsNull: true,
      },
    }, total)
    expect(r).toMatchObject({ status: 'completed', inserted: total, rowsInTable: total })
    // memory held after the first quarter doesn't grow with the rest of the file
    expect(r.heapGrowthMb).toBeLessThan(32)
  })

  it('imports a 200,000-row XLSX with flat memory', async () => {
    const total = 200_000
    const file = path.join(dir, 'big.xlsx')
    const writer = new (ExcelJS as any).stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: true })
    const sheet = writer.addWorksheet('Data')
    sheet.addRow(['id', 'name', 'amount', 'day']).commit()
    for (let i = 1; i <= total; i++) {
      sheet.addRow([i, `name ${i}`, (i % 1000) / 4, new Date(Date.UTC(2024, 0, (i % 28) + 1))]).commit()
    }
    sheet.commit()
    await writer.commit()

    const r = await measure({
      filePath: file,
      parse: { format: 'xlsx', headerRow: 1 },
      target: { table: 'big' },
      mappings: autoMap(['id', 'name', 'amount', 'day'], ['id', 'name', 'amount', 'day']),
      options: {
        mode: 'append', keyColumns: [], useTransaction: true, batchSize: 1000, errorMode: 'stop',
        decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', emptyAsNull: true,
      },
    }, total)
    expect(r).toMatchObject({ status: 'completed', inserted: total, rowsInTable: total })
    expect(r.heapGrowthMb).toBeLessThan(32)
  })
})

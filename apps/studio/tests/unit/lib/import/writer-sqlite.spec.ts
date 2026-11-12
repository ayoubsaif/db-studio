import fs from 'fs'
import os from 'os'
import path from 'path'
import { createServer } from '@/lib/db'
import { ImportJob } from '@/lib/import/engine'
import { autoMap } from '@/lib/import/engine'
import { ImportMode, ImportOptions, ImportRequest } from '@/lib/import/types'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-import-sqlite-'))
let client: any
let fileCount = 0

function csvFile(lines: string[]) {
  const p = path.join(dir, `f${fileCount++}.csv`)
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}

async function sql(q: string) {
  return client.executeQuery(q)
}

async function rows(table = 'people') {
  const [result] = await sql(`SELECT * FROM ${table} ORDER BY 1, 2`)
  // the SQLite client returns integers as BigInt
  return result.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])))
}

async function runImport(lines: string[], mode: ImportMode, extra: Partial<ImportOptions> = {}, table = 'people', tableColumns = ['id', 'name', 'age']) {
  const filePath = csvFile(lines)
  const header = lines[0].split(',')
  const request: ImportRequest = {
    filePath,
    parse: { format: 'csv', headerRow: 1, csv: {} },
    target: { table },
    mappings: autoMap(header, tableColumns),
    options: {
      mode, keyColumns: ['id'], useTransaction: true, batchSize: 500, errorMode: 'stop',
      decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', emptyAsNull: true, ...extra,
    },
  }
  return new ImportJob(client, 'sqlite', request).run()
}

beforeAll(async () => {
  const server = createServer({ client: 'sqlite' } as any)
  client = server.createConnection(path.join(dir, 'test.db'))
  await client.connect()
})

afterAll(async () => {
  await client?.disconnect()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_e) {
    // Windows can keep the database file locked for a moment; it's a temp dir
  }
})

beforeEach(async () => {
  await sql('DROP TABLE IF EXISTS people; CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER CHECK (age >= 0))')
  await sql("INSERT INTO people VALUES (1, 'Ana', 30), (2, 'Bo', 40)")
})

describe('import modes on SQLite', () => {
  it('Append inserts every row', async () => {
    const s = await runImport(['id,name,age', '3,Cy,20', '4,Di,21'], 'append')
    expect(s).toMatchObject({ status: 'completed', inserted: 2, read: 2, failed: 0 })
    expect((await rows()).map((r) => r.id)).toEqual([1, 2, 3, 4])
  })

  it('Update changes matching rows and skips the rest', async () => {
    const s = await runImport(['id,name,age', '2,Bob,41', '9,Nobody,1'], 'update')
    expect(s).toMatchObject({ status: 'completed', updated: 1, skipped: 1, inserted: 0 })
    expect(await rows()).toEqual([{ id: 1, name: 'Ana', age: 30 }, { id: 2, name: 'Bob', age: 41 }])
  })

  it('Append/Update updates row 2, inserts row 3 and leaves row 1 alone', async () => {
    const s = await runImport(['id,name,age', '2,Bob,41', '3,Cy,20'], 'appendUpdate')
    expect(s).toMatchObject({ status: 'completed', updated: 1, inserted: 1 })
    expect(await rows()).toEqual([
      { id: 1, name: 'Ana', age: 30 }, { id: 2, name: 'Bob', age: 41 }, { id: 3, name: 'Cy', age: 20 },
    ])
  })

  it('Append without update keeps the old row 2 and inserts row 3', async () => {
    await sql("UPDATE people SET name = 'old' WHERE id = 2")
    const s = await runImport(['id,name,age', '2,new,1', '3,Cy,20'], 'appendNoUpdate')
    expect(s).toMatchObject({ status: 'completed', inserted: 1, skipped: 1, updated: 0 })
    expect((await rows()).map((r) => [r.id, r.name])).toEqual([[1, 'Ana'], [2, 'old'], [3, 'Cy']])
  })

  it('Delete removes matching rows and skips unknown keys', async () => {
    const s = await runImport(['id', '1', '5'], 'delete')
    expect(s).toMatchObject({ status: 'completed', deleted: 1, skipped: 1 })
    expect((await rows()).map((r) => r.id)).toEqual([2])
  })

  it('Copy empties the table, then inserts every row', async () => {
    const s = await runImport(['id,name,age', '7,Gil,50'], 'copy')
    expect(s).toMatchObject({ status: 'completed', inserted: 1 })
    expect(await rows()).toEqual([{ id: 7, name: 'Gil', age: 50 }])
  })

  it('applies the last of two rows with the same key and reports the duplicate', async () => {
    const s = await runImport(['id,name,age', '2,first,1', '2,second,2'], 'update')
    expect(s).toMatchObject({ status: 'completed', updated: 1, skipped: 1, duplicateKeys: 1 })
    expect((await rows())[1]).toEqual({ id: 2, name: 'second', age: 2 })
  })

  it('handles a key repeated across batches', async () => {
    const s = await runImport(['id,name,age', '5,a,1', '6,b,1', '5,c,1'], 'appendUpdate', { batchSize: 2 })
    expect(s).toMatchObject({ status: 'completed', inserted: 2, updated: 1, duplicateKeys: 1 })
    expect((await rows()).find((r) => r.id === 5).name).toBe('c')
  })

  it('matches on a composite key', async () => {
    await sql('DROP TABLE IF EXISTS stock; CREATE TABLE stock (shop TEXT, sku TEXT, qty INTEGER, PRIMARY KEY (shop, sku))')
    await sql("INSERT INTO stock VALUES ('A', 'x', 1), ('A', 'y', 2), ('B', 'x', 3)")
    const s = await runImport(['shop,sku,qty', 'A,y,20', 'B,y,30'], 'appendUpdate', { keyColumns: ['shop', 'sku'] }, 'stock', ['shop', 'sku', 'qty'])
    expect(s).toMatchObject({ status: 'completed', updated: 1, inserted: 1 })
    expect(await rows('stock')).toEqual([
      { shop: 'A', sku: 'x', qty: 1 }, { shop: 'A', sku: 'y', qty: 20 }, { shop: 'B', sku: 'x', qty: 3 }, { shop: 'B', sku: 'y', qty: 30 },
    ])
  })

  it('treats a NULL key as no match', async () => {
    const s = await runImport(['id,name,age', ',ghost,1'], 'update')
    expect(s).toMatchObject({ status: 'completed', updated: 0, skipped: 1 })
  })
})

describe('errors and transactions on SQLite', () => {
  const many = (bad: number[]) => ['id,name,age', ...Array.from({ length: 30 }, (_v, i) => `${i + 10},p${i + 10},${bad.includes(i + 10) ? -1 : 5}`)]

  it('stop on first error rolls back everything and names the file row', async () => {
    // id 25 is on file row 17 (header is row 1, id 10 is row 2)
    const s = await runImport(many([25]), 'append', { batchSize: 7 })
    expect(s.status).toBe('failed')
    expect(s.rolledBack).toBe(true)
    expect(s.error).toMatch(/^Row 17: .*CHECK constraint failed/)
    expect(s.errors.map((e) => e.rowNumber)).toEqual([17])
    expect((await rows()).map((r) => r.id)).toEqual([1, 2])
  })

  it('continue mode imports the other rows and lists the failed ones', async () => {
    const s = await runImport(many([12, 22]), 'append', { batchSize: 7, errorMode: 'continue' })
    expect(s).toMatchObject({ status: 'completed', inserted: 28, failed: 2 })
    expect(s.errors.map((e) => e.rowNumber)).toEqual([4, 14])
    expect((await rows()).length).toBe(30)
  })

  it('reports a value that is not a number as a failed row', async () => {
    const s = await runImport(['id,name,age', '3,Cy,abc', '4,Di,9'], 'append', { errorMode: 'continue' })
    expect(s).toMatchObject({ status: 'completed', inserted: 1, failed: 1 })
    expect(s.errors[0]).toMatchObject({ rowNumber: 2, column: 'age', value: 'abc' })
  })

  it('without a transaction, rows before the error stay', async () => {
    const s = await runImport(many([25]), 'append', { batchSize: 7, useTransaction: false })
    expect(s).toMatchObject({ status: 'failed', rolledBack: false, inserted: 15 })
    expect((await rows()).length).toBe(17)
  })

  it('refuses a keyed mode without a key', async () => {
    const s = await runImport(['id,name,age', '2,x,1'], 'update', { keyColumns: [] })
    expect(s.status).toBe('failed')
    expect(s.error).toMatch(/needs at least one key column/)
  })

  it('cancelling a transactional import rolls it back', async () => {
    const lines = ['id,name,age', ...Array.from({ length: 2000 }, (_v, i) => `${i + 100},n,1`)]
    const filePath = csvFile(lines)
    const job = new ImportJob(client, 'sqlite', {
      filePath,
      parse: { format: 'csv', headerRow: 1, csv: {} },
      target: { table: 'people' },
      mappings: autoMap(['id', 'name', 'age'], ['id', 'name', 'age']),
      options: {
        mode: 'append', keyColumns: [], useTransaction: true, batchSize: 100, errorMode: 'stop',
        decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', emptyAsNull: true,
      },
    })
    job.onProgress((p) => { if (p.inserted >= 500) job.cancel() })
    const s = await job.run()
    expect(s).toMatchObject({ status: 'cancelled', rolledBack: true, error: null })
    expect((await rows()).length).toBe(2)
  })
})

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createServer } from '@/lib/db'
import { autoMap, ImportJob } from '@/lib/import/engine'
import { ImportMode, ImportOptions, ImportRequest, ImportSummary } from '@/lib/import/types'
import { Dialect } from '@shared/lib/dialects/models'

/**
 * Runs the import engine against real servers. SQLite always runs; start the
 * others, for example with docker, and set their URLs:
 *   IMPORT_TEST_POSTGRES=postgres://postgres:example@localhost:5432/postgres
 *   IMPORT_TEST_MYSQL=mysql://root:example@localhost:3306/bks
 *   IMPORT_TEST_SQLSERVER=mssql://sa:Example_Passw0rd@localhost:1433/master
 *   IMPORT_TEST_CLICKHOUSE=http://default@localhost:8123/default
 * Each database is skipped when its URL is not set.
 */
interface TestServer {
  name: string
  dialect: Dialect
  client: string
  url?: string
  defaultPort?: number
  schema?: string
  transactions: boolean
  /** CREATE TABLE people (id, name, age) where age must be >= 0 */
  ddl: string
  extraConfig?: Record<string, any>
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-import-it-'))

const servers: TestServer[] = [
  {
    name: 'SQLite', dialect: 'sqlite', client: 'sqlite', url: `sqlite:${path.join(dir, 'it.db')}`, transactions: true,
    ddl: 'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER CHECK (age >= 0))',
  },
  {
    name: 'Postgres', dialect: 'postgresql', client: 'postgresql', url: process.env.IMPORT_TEST_POSTGRES, defaultPort: 5432,
    schema: 'public', transactions: true,
    ddl: 'CREATE TABLE people (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, age INTEGER CHECK (age >= 0))',
  },
  {
    name: 'MySQL', dialect: 'mysql', client: 'mysql', url: process.env.IMPORT_TEST_MYSQL, defaultPort: 3306, transactions: true,
    ddl: 'CREATE TABLE people (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, age INTEGER CHECK (age >= 0)) DEFAULT CHARSET utf8mb4',
  },
  {
    name: 'SQL Server', dialect: 'sqlserver', client: 'sqlserver', url: process.env.IMPORT_TEST_SQLSERVER, defaultPort: 1433,
    schema: 'dbo', transactions: true, extraConfig: { trustServerCertificate: true },
    ddl: 'CREATE TABLE people (id INTEGER PRIMARY KEY, name NVARCHAR(50) NOT NULL, age INTEGER CHECK (age >= 0))',
  },
  {
    name: 'ClickHouse', dialect: 'clickhouse', client: 'clickhouse', url: process.env.IMPORT_TEST_CLICKHOUSE, defaultPort: 8123,
    transactions: false,
    ddl: 'CREATE TABLE people (id Int32, name String, age Int32, CONSTRAINT age_ok CHECK age >= 0) ENGINE = MergeTree ORDER BY id',
  },
]

let fileCount = 0
function csvFile(lines: string[]) {
  const p = path.join(dir, `f${fileCount++}.csv`)
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_e) {
    // Windows may still hold the SQLite file
  }
})

for (const server of servers) {
  const describeIf = server.url ? describe : describe.skip

  describeIf(`import on ${server.name}`, () => {
    jest.setTimeout(180000)
    let conn: any
    const itTx = server.transactions ? it : it.skip

    function request(lines: string[], mode: ImportMode, extra: Partial<ImportOptions> = {}): ImportRequest {
      return {
        filePath: csvFile(lines),
        parse: { format: 'csv', headerRow: 1, csv: {} },
        target: { table: 'people', schema: server.schema || null },
        mappings: autoMap(lines[0].split(','), ['id', 'name', 'age']),
        options: {
          mode, keyColumns: ['id'], useTransaction: true, batchSize: 100, errorMode: 'stop',
          decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', emptyAsNull: true, ...extra,
        },
      }
    }

    const run = (lines: string[], mode: ImportMode, extra: Partial<ImportOptions> = {}) =>
      new ImportJob(conn, server.dialect, request(lines, mode, extra)).run()

    async function table(): Promise<[number, string, number][]> {
      const [result] = await conn.executeQuery('SELECT id, name, age FROM people ORDER BY id')
      const ids = ['id', 'name', 'age'].map((n) => result.fields.find((f) => f.name === n).id)
      return result.rows.map((r) => [Number(r[ids[0]]), r[ids[1]], Number(r[ids[2]])])
    }

    // row n of the file holds id n + 1000; the header is row 1
    const file = (count: number, bad: number[] = []) => ['id,name,age', ...Array.from({ length: count }, (_v, i) => {
      const rowNumber = i + 2
      return `${rowNumber + 1000},p${rowNumber},${bad.includes(rowNumber) ? -1 : 1}`
    })]

    beforeAll(async () => {
      let s
      let database: string
      if (server.client === 'sqlite') {
        s = createServer({ client: 'sqlite' } as any)
        database = server.url.replace(/^sqlite:/, '')
      } else {
        const u = new URL(server.url)
        s = createServer({
          client: server.client, host: u.hostname, port: Number(u.port) || server.defaultPort,
          user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
          ...(server.extraConfig || {}),
        } as any)
        database = u.pathname.replace(/^\//, '')
      }
      conn = s.createConnection(database)
      await conn.connect()
    })

    afterAll(async () => {
      await conn?.executeQuery('DROP TABLE IF EXISTS people')
      await conn?.disconnect()
    })

    beforeEach(async () => {
      await conn.executeQuery('DROP TABLE IF EXISTS people')
      await conn.executeQuery(server.ddl)
      await conn.executeQuery("INSERT INTO people (id, name, age) VALUES (1, 'Ana', 30), (2, 'Bo', 40)")
    })

    it('Append/Update updates row 2, inserts row 3 and leaves row 1 alone', async () => {
      const s = await run(['id,name,age', '2,Bob,41', '3,Cy,20'], 'appendUpdate')
      expect(s).toMatchObject({ status: 'completed', updated: 1, inserted: 1 })
      expect(await table()).toEqual([[1, 'Ana', 30], [2, 'Bob', 41], [3, 'Cy', 20]])
    })

    it('Update, Append without update, Delete, duplicates and Copy give the spec results', async () => {
      expect(await run(['id,name,age', '2,new,1', '3,Cy,20'], 'appendNoUpdate')).toMatchObject({ inserted: 1, skipped: 1 })
      expect((await table())[1]).toEqual([2, 'Bo', 40])
      expect(await run(['id,name,age', '3,first,1', '3,second,2', '9,none,1'], 'update')).toMatchObject({ updated: 1, skipped: 2, duplicateKeys: 1 })
      expect(await run(['id', '1', '5'], 'delete')).toMatchObject({ deleted: 1, skipped: 1 })
      expect(await table()).toEqual([[2, 'Bo', 40], [3, 'second', 2]])
      expect(await run(['id,name,age', '9,z,9'], 'copy')).toMatchObject({ inserted: 1 })
      expect(await table()).toEqual([[9, 'z', 9]])
    })

    it('keeps text outside ASCII intact', async () => {
      const s = await run(['id,name,age', '5,Ñandú 東京 ü€,1'], 'append')
      expect(s).toMatchObject({ status: 'completed', inserted: 1 })
      expect((await table()).find((r) => r[0] === 5)[1]).toBe('Ñandú 東京 ü€')
    })

    itTx('row 501 failing in stop mode leaves the table as it was and names row 501', async () => {
      const s = await run(file(700, [501]), 'append')
      expect(s).toMatchObject({ status: 'failed', rolledBack: true })
      expect(s.error).toMatch(/^Row 501: /)
      expect(await table()).toEqual([[1, 'Ana', 30], [2, 'Bo', 40]])
    })

    it('continue mode imports every other row and reports rows 10 and 20', async () => {
      const s = await run(file(300, [10, 20]), 'append', { errorMode: 'continue' })
      expect(s).toMatchObject({ status: 'completed', inserted: 298, failed: 2 })
      expect(s.errors.map((e) => e.rowNumber)).toEqual([10, 20])
      expect((await table()).length).toBe(300)
    })

    it('without a transaction, rows before the error stay', async () => {
      const s = await run(file(300, [250]), 'append', { useTransaction: false })
      expect(s).toMatchObject({ status: 'failed', rolledBack: false, inserted: 248 })
      expect((await table()).length).toBe(250)
    })

    itTx('cancelling a transactional import rolls it back', async () => {
      const job = new ImportJob(conn, server.dialect, request(file(5000), 'append'))
      job.onProgress((p) => { if (p.inserted >= 1000) job.cancel() })
      const s = await job.run()
      expect(s).toMatchObject({ status: 'cancelled', rolledBack: true, error: null })
      expect((await table()).length).toBe(2)
    })

    it('cancelling without a transaction stops after the current batch', async () => {
      const job = new ImportJob(conn, server.dialect, request(file(5000), 'append', { useTransaction: false }))
      let cancelledAt = -1
      job.onProgress((p) => {
        if (cancelledAt < 0 && p.inserted >= 1000) {
          cancelledAt = p.inserted
          job.cancel()
        }
      })
      const s = await job.run()
      expect(s).toMatchObject({ status: 'cancelled', rolledBack: false })
      expect(s.inserted).toBe(cancelledAt)
      expect((await table()).length).toBe(2 + cancelledAt)
    })

    if (server.dialect === 'postgresql') {
      describe('native upsert', () => {
        async function both(lines: string[], mode: ImportMode): Promise<[ImportSummary, any[], ImportSummary, any[]]> {
          await conn.executeQuery('DELETE FROM people')
          await conn.executeQuery("INSERT INTO people (id, name, age) VALUES (1, 'Ana', 30), (2, 'Bo', 40)")
          const native = await run(lines, mode)
          const nativeRows = await table()
          await conn.executeQuery('DELETE FROM people')
          await conn.executeQuery("INSERT INTO people (id, name, age) VALUES (1, 'Ana', 30), (2, 'Bo', 40)")
          const generic = await run(lines, mode, { nativeUpsert: false })
          return [native, nativeRows, generic, await table()]
        }
        const counts = (s: ImportSummary) => [s.status, s.inserted, s.updated, s.skipped, s.failed, s.duplicateKeys]
        // an update, inserts, and a key repeated in the file
        const lines = ['id,name,age', '2,Bob,41', '3,Cy,20', '3,Cyd,21', '4,Di,22']

        it('gives the same table and counts for Append/Update', async () => {
          const [native, nRows, generic, gRows] = await both(lines, 'appendUpdate')
          expect(native.nativeUpsert).toBe(true)
          expect(generic.nativeUpsert).toBe(false)
          expect(nRows).toEqual(gRows)
          expect(counts(native)).toEqual(counts(generic))
        })

        it('gives the same table and counts for Append without update', async () => {
          const [native, nRows, generic, gRows] = await both(lines, 'appendNoUpdate')
          expect(native.nativeUpsert).toBe(true)
          expect(nRows).toEqual(gRows)
          expect(counts(native)).toEqual(counts(generic))
        })

        it('is not used when the keys are not a unique constraint', async () => {
          const s = await run(['id,name,age', '2,x,1'], 'appendUpdate', { keyColumns: ['name'] })
          expect(s.nativeUpsert).toBe(false)
        })
      })
    }
  })
}

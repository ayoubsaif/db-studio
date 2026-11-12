import { createServer } from '@/lib/db'
import { IDbConnectionServerConfig } from '@/lib/db/types'
import { ClickHouseClient } from '@/lib/db/clients/clickhouse'

/**
 * Runs against a real server, for example `docker compose up clickhouse`, then:
 *   CLICKHOUSE_TEST_URL=http://default:example@localhost:8123 yarn test:integration clickhouse
 * Skipped when CLICKHOUSE_TEST_URL is not set.
 */
const url = process.env.CLICKHOUSE_TEST_URL
const describeIfServer = url ? describe : describe.skip

const DB = 'bks_test'

function serverConfig(): IDbConnectionServerConfig {
  const u = new URL(url)
  return {
    client: 'clickhouse',
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 8443 : 8123),
    user: decodeURIComponent(u.username) || 'default',
    password: decodeURIComponent(u.password),
    ssl: u.protocol === 'https:',
    sslRejectUnauthorized: false,
    readOnlyMode: false,
  } as IDbConnectionServerConfig
}

async function connectTo(database: string): Promise<ClickHouseClient> {
  const server = createServer(serverConfig())
  const connection = server.createConnection(database) as unknown as ClickHouseClient
  await connection.connect()
  return connection
}

async function readAll(cursor): Promise<any[][][]> {
  await cursor.start()
  const chunks = []
  for (;;) {
    const chunk = await cursor.read()
    if (!chunk.length) break
    chunks.push(chunk)
  }
  return chunks
}

describeIfServer('ClickHouse client', () => {
  jest.setTimeout(120000)
  let admin: ClickHouseClient
  let conn: ClickHouseClient

  beforeAll(async () => {
    admin = await connectTo('default')
    await admin.executeQuery(`DROP DATABASE IF EXISTS ${DB}`)
    await admin.createDatabase(DB, null, null)
    conn = await connectTo(DB)
    await conn.executeQuery(`
      CREATE TABLE events (id UInt64, kind String, name Nullable(String), sold_on Date, note String DEFAULT 'none' COMMENT 'a note')
      ENGINE = MergeTree ORDER BY (id, kind) COMMENT 'event log';
      INSERT INTO events (id, kind, name, sold_on) VALUES (1, 'a', 'one', '2024-01-01'), (2, 'b', 'two', '2024-01-02'), (3, 'a', NULL, '2024-01-03');
      CREATE TABLE big (n UInt64) ENGINE = MergeTree ORDER BY n;
      INSERT INTO big SELECT number FROM numbers(100000);
      CREATE VIEW events_a AS SELECT * FROM events WHERE kind = 'a';
      CREATE MATERIALIZED VIEW events_count ENGINE = SummingMergeTree ORDER BY kind AS SELECT kind, count() AS c FROM events GROUP BY kind;
    `)
  })

  afterAll(async () => {
    await conn?.disconnect()
    await admin?.executeQuery(`DROP DATABASE IF EXISTS ${DB}`)
    await admin?.disconnect()
  })

  it('reports the server version', async () => {
    expect(await conn.versionString()).toMatch(/^\d+\.\d+/)
  })

  it('fails to connect with a wrong password, showing the server error', async () => {
    const server = createServer({ ...serverConfig(), password: 'definitely-wrong' })
    const bad = server.createConnection(DB)
    await expect(bad.connect()).rejects.toThrow(/password|Authentication/i)
  })

  it('lists user databases without system ones', async () => {
    const dbs = await admin.listDatabases()
    expect(dbs).toContain(DB)
    expect(dbs).not.toContain('system')
    expect(dbs).not.toContain('information_schema')
  })

  it('lists tables, views and materialized views separately', async () => {
    expect((await conn.listTables()).map((t) => t.name)).toEqual(['big', 'events'])
    expect((await conn.listViews()).map((t) => t.name)).toEqual(['events_a'])
    const mvs = await conn.listMaterializedViews()
    expect(mvs.map((t) => [t.name, t.entityType])).toEqual([['events_count', 'materialized-view']])
  })

  it('lists columns with types, defaults and key flags', async () => {
    const cols = await conn.listTableColumns('events')
    expect(cols.map((c) => [c.columnName, c.dataType, c.primaryKey])).toEqual([
      ['id', 'UInt64', true], ['kind', 'String', true], ['name', 'Nullable(String)', false],
      ['sold_on', 'Date', false], ['note', 'String', false],
    ])
    const note = cols.find((c) => c.columnName === 'note')
    expect(note.defaultValue).toBe("'none'")
    expect(note.comment).toBe('a note')
    expect(cols.find((c) => c.columnName === 'name').nullable).toBe(true)
  })

  it('returns every primary key column in key order', async () => {
    expect(await conn.getPrimaryKeys('events')).toEqual([
      { columnName: 'id', position: 1 }, { columnName: 'kind', position: 2 },
    ])
    expect(await conn.getPrimaryKey('events')).toBeNull()
    expect(await conn.getPrimaryKey('big')).toBe('n')
  })

  it('runs several statements and returns each result', async () => {
    const results = await conn.executeQuery('SELECT 1 AS a, toUInt64(18446744073709551615) AS big; CREATE TABLE tmp (x Int8) ENGINE = Memory; DROP TABLE tmp')
    expect(results).toHaveLength(3)
    expect(results[0].fields.map((f) => f.name)).toEqual(['a', 'big'])
    // 64-bit values arrive as exact strings
    expect(results[0].rows).toEqual([{ c0: 1, c1: '18446744073709551615' }])
    expect(results[1].command).toBe('CREATE')
  })

  it('shows the server message for invalid SQL', async () => {
    await expect(conn.executeQuery('SELEC 1')).rejects.toThrow(/Syntax error/i)
  })

  it('cancels a running query on the server', async () => {
    const query = await conn.query('SELECT count() FROM numbers_mt(1000000000000) WHERE sipHash64(number) = 0')
    const running = query.execute().then(() => null, (e) => e)
    await new Promise((r) => setTimeout(r, 1000))
    await query.cancel()
    const error = await running
    expect(error?.sqlectronError).toBe('CANCELED_BY_USER')
    // the query is gone from the server shortly after
    await new Promise((r) => setTimeout(r, 2000))
    const [left] = await admin.executeQuery(
      "SELECT count() AS c FROM system.processes WHERE query LIKE '%numbers_mt(1000000000000)%' AND query NOT LIKE '%system.processes%'"
    )
    expect(Number(left.rows[0].c0)).toBe(0)
  })

  it('pages, sorts and filters table data', async () => {
    const page = await conn.selectTop('events', 1, 1, [{ field: 'id', dir: 'ASC' }], [])
    expect(page.result).toEqual([expect.objectContaining({ id: '2', kind: 'b' })])
    const filtered = await conn.selectTop('events', 0, 10, [], [{ field: 'id', type: '>', value: '1' }])
    expect(filtered.result.map((r) => r.id).sort()).toEqual(['2', '3'])
    expect(await conn.getTableLength('events')).toBe(3)
  })

  it('streams 100k rows in chunks', async () => {
    const { totalRows, columns, cursor } = await conn.selectTopStream('big', [], [], 5000)
    expect(totalRows).toBe(100000)
    expect(columns.map((c) => c.columnName)).toEqual(['n'])
    const chunks = await readAll(cursor)
    expect(chunks.every((c) => c.length <= 5000)).toBe(true)
    expect(chunks.reduce((sum, c) => sum + c.length, 0)).toBe(100000)
  })

  it('streams a query, with columns and a row count', async () => {
    const { totalRows, columns, cursor } = await conn.queryStream('SELECT n, n * 2 AS twice FROM big WHERE n < 1234', 500)
    expect(totalRows).toBe(1234)
    expect(columns.map((c) => c.columnName)).toEqual(['n', 'twice'])
    expect((await readAll(cursor)).flat()).toHaveLength(1234)
  })

  it('provides the create script, properties and comment', async () => {
    expect(await conn.getTableCreateScript('events')).toMatch(/^CREATE TABLE bks_test\.events/)
    expect((await conn.getViewCreateScript('events_a'))[0]).toMatch(/CREATE VIEW/)
    const props = await conn.getTableProperties('events')
    expect(props.description).toBe('event log')
    expect((props as any).length).toBe(3)
    expect(props.size).toBeGreaterThan(0)
  })

  it('inserts, updates and deletes rows, waiting for the mutations', async () => {
    await conn.applyChanges({
      inserts: [{ table: 'events', data: [{ id: 10, kind: 'c', name: 'back\\slash', sold_on: '2024-02-01' }] }],
      updates: [], deletes: [],
    })
    const updated = await conn.applyChanges({
      inserts: [],
      updates: [{ table: 'events', column: 'name', value: "it's", primaryKeys: [{ column: 'id', value: 10 }, { column: 'kind', value: 'c' }] }],
      deletes: [{ table: 'events', primaryKeys: [{ column: 'id', value: 2 }, { column: 'kind', value: 'b' }] }],
    })
    expect(updated).toEqual([expect.objectContaining({ id: '10', name: "it's" })])
    const rows = (await conn.selectTop('events', 0, 10, [{ field: 'id', dir: 'ASC' }], [])).result
    expect(rows.map((r) => r.id)).toEqual(['1', '3', '10'])

    // the backslash survives the round trip unchanged
    await conn.applyChanges({ inserts: [{ table: 'events', data: [{ id: 11, kind: 'c', name: 'a\\b', sold_on: '2024-02-01' }] }], updates: [], deletes: [] })
    const [check] = await conn.executeQuery("SELECT name FROM events WHERE id = 11")
    expect(check.rows[0].c0).toBe('a\\b')
  })

  it('says which changes were applied when one fails', async () => {
    const attempt = conn.applyChanges({
      inserts: [{ table: 'events', data: [{ id: 20, kind: 'z', sold_on: '2024-03-01' }] }],
      // key columns can't be updated in ClickHouse
      updates: [{ table: 'events', column: 'id', value: 99, primaryKeys: [{ column: 'id', value: 1 }, { column: 'kind', value: 'a' }] }],
      deletes: [{ table: 'events', primaryKeys: [{ column: 'id', value: 3 }, { column: 'kind', value: 'a' }] }],
    })
    await expect(attempt).rejects.toThrow(/Change 2 of 3 failed: .*The first 1 of 3 changes were already applied/)
    const [after] = await conn.executeQuery('SELECT count() FROM events WHERE id IN (3, 20)')
    expect(Number(after.rows[0].c0)).toBe(2)
  })

  it('renames, duplicates, truncates and drops tables', async () => {
    await conn.duplicateTable('events', 'events_copy')
    expect(await conn.getTableLength('events_copy')).toBe(await conn.getTableLength('events'))
    await conn.setElementName('events_copy', 'events_renamed', 'TABLE' as any)
    await conn.truncateElement('events_renamed', 'TABLE' as any)
    expect(await conn.getTableLength('events_renamed')).toBe(0)
    await conn.dropElement('events_renamed', 'TABLE' as any)
    expect((await conn.listTables()).map((t) => t.name)).not.toContain('events_renamed')
  })
})

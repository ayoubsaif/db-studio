import knexlib from 'knex'
import { ClickhouseKnexClient } from '@shared/lib/knex-clickhouse'
import { ClickHouseData } from '@shared/lib/dialects/clickhouse'
import { ClickHouseClient, returnsRows, splitStatements } from '@/lib/db/clients/clickhouse'

const knex = knexlib({ client: ClickhouseKnexClient as any })

describe('ClickHouse SQL builder', () => {
  it('builds a select', () => {
    expect(knex('events').where({ id: 1 }).select('*').toQuery())
      .toBe('select * from "events" where "id" = 1')
  })

  it('builds an insert', () => {
    expect(knex('events').insert({ name: 'x', n: 2 }).toQuery())
      .toBe('insert into "events" ("n", "name") values (2, \'x\')')
  })

  it('builds an update as a mutation', () => {
    expect(knex('events').where({ id: 1 }).update({ name: 'y' }).toQuery())
      .toBe('alter table "events" update "name" = \'y\' where "id" = 1')
  })

  it('builds a lightweight delete', () => {
    expect(knex('events').where({ id: 1, kind: 'a' }).delete().toQuery())
      .toBe('delete from "events" where "id" = 1 and "kind" = \'a\'')
  })

  it('quotes identifiers with embedded quotes', () => {
    expect(knex('my"table').select('we"ird').toQuery())
      .toBe('select "we""ird" from "my""table"')
  })

  it('escapes quotes and backslashes once', () => {
    // ClickHouse reads 'a\\b' as a\b and 'O''Brien' as O'Brien
    expect(knex.raw('?', ['a\\b']).toQuery()).toBe("'a\\\\b'")
    expect(knex.raw('?', ["O'Brien"]).toQuery()).toBe("'O''Brien'")
  })

  it('writes nulls and booleans as literals', () => {
    expect(knex.raw('?, ?, ?', [null, true, false]).toQuery()).toBe('NULL, true, false')
  })
})

describe('ClickHouse dialect', () => {
  it('wraps identifiers in double quotes', () => {
    expect(ClickHouseData.wrapIdentifier('a"b')).toBe('"a""b"')
    expect(ClickHouseData.wrapIdentifier('*')).toBe('*')
  })

  it('escapes backslashes in string literals', () => {
    expect(ClickHouseData.escapeString('C:\\new', true)).toBe("'C:\\\\new'")
    expect(ClickHouseData.escapeString("it's", true)).toBe("'it''s'")
  })
})

describe('ClickHouse statement handling', () => {
  it('splits a script into statements', () => {
    expect(splitStatements('SELECT 1; INSERT INTO t VALUES (1);\nSHOW TABLES'))
      .toEqual(['SELECT 1;', 'INSERT INTO t VALUES (1);', 'SHOW TABLES'])
  })

  it('drops empty and comment-only statements', () => {
    expect(splitStatements('SELECT 1;;\n-- just a note\n')).toEqual(['SELECT 1;'])
  })

  it('knows which statements return rows', () => {
    expect(returnsRows('SELECT 1')).toBe(true)
    expect(returnsRows('  -- comment\nwith x as (select 1) select * from x')).toBe(true)
    expect(returnsRows('(SELECT 1) UNION ALL (SELECT 2)')).toBe(true)
    expect(returnsRows('SHOW CREATE TABLE t')).toBe(true)
    expect(returnsRows('DESCRIBE t')).toBe(true)
    expect(returnsRows('INSERT INTO t SELECT 1')).toBe(false)
    expect(returnsRows('ALTER TABLE t UPDATE a = 1 WHERE 1')).toBe(false)
    expect(returnsRows('CREATE TABLE t (a Int32) ENGINE = Memory')).toBe(false)
  })
})

describe('ClickHouseClient SQL', () => {
  function client() {
    const server: any = { config: { client: 'clickhouse', host: 'localhost', port: 8123 }, db: {} }
    const c = new ClickHouseClient(server, { database: 'analytics' } as any)
    c.knex = knex
    jest.spyOn(c, 'listTableColumns').mockResolvedValue([
      { columnName: 'id', dataType: 'UInt64' },
      { columnName: 'name', dataType: 'String' },
    ] as any)
    return c
  }

  it('builds a filtered, sorted page of table data', async () => {
    const sql = await client().selectTopSql(
      'events', 100, 50,
      [{ field: 'name', dir: 'DESC' }],
      [{ field: 'name', type: 'like', value: "%o'k%" }, { field: 'id', type: '>', value: '10', op: 'AND' }]
    )
    expect(sql).toBe(
      'SELECT * FROM "analytics"."events" WHERE `name` LIKE \'%o\'\'k%\' AND `id` > \'10\' ORDER BY "name" DESC LIMIT 50 OFFSET 100'
    )
  })

  it('passes a raw filter string through', async () => {
    const sql = await client().selectTopSql('events', 0, 10, [], 'id > 5')
    expect(sql).toBe('SELECT * FROM "analytics"."events" WHERE id > 5 LIMIT 10 OFFSET 0')
  })

  it('builds insert, mutation update and delete for pending edits', async () => {
    const sql = await client().applyChangesSql({
      inserts: [{ table: 'events', data: [{ id: 3, name: 'new' }] }],
      updates: [{ table: 'events', column: 'name', value: 'changed', primaryKeys: [{ column: 'id', value: 1 }] }],
      deletes: [{ table: 'events', primaryKeys: [{ column: 'id', value: 2 }] }],
    })
    expect(sql).toBe([
      'insert into "events" ("id", "name") values (3, \'new\')',
      'alter table "events" update "name" = \'changed\' where "id" = 1',
      'delete from "events" where "id" = 2',
    ].join(';\n') + ';')
  })
})

describe('ClickHouse registration', () => {
  it('creates a ClickHouseClient for clickhouse connections', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createServer } = require('@/lib/db')
    const server = createServer({ client: 'clickhouse', host: 'localhost', port: 8123 })
    expect(server.createConnection('default')).toBeInstanceOf(ClickHouseClient)
  })
})

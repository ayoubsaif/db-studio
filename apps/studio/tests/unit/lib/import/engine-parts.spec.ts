import knexlib from 'knex'
import { batches, maxBatchSize } from '@/lib/import/batcher'
import { ExistingKeys, keyLookupQuery, keyString, normalizeKeyPart } from '@/lib/import/keys'
import { importSupport, isModeEnabled } from '@/lib/import/support'
import { autoMap, importWarnings, validateImport } from '@/lib/import/engine'
import { ImportModes, ImportOptions } from '@/lib/import/types'
import { Dialects } from '@shared/lib/dialects/models'

describe('batch size', () => {
  it('keeps SQL Server under 2100 parameters and 1000 rows', () => {
    expect(maxBatchSize('sqlserver', 3, 5000)).toBe(700)
    expect(maxBatchSize('sqlserver', 1, 5000)).toBe(1000)
    expect(maxBatchSize('sqlserver', 30, 500)).toBe(70)
    expect(maxBatchSize('sqlserver', 3000, 500)).toBe(1)
  })

  it('keeps SQLite under 32766 parameters', () => {
    expect(maxBatchSize('sqlite', 100, 5000)).toBe(327)
    expect(maxBatchSize('sqlite', 2, 500)).toBe(500)
  })

  it('uses the requested size where it fits', () => {
    expect(maxBatchSize('postgresql', 10, 250)).toBe(250)
    expect(maxBatchSize('oracle', 2, 5000)).toBe(1000)
    expect(maxBatchSize('postgresql', 10, 0)).toBe(500)
  })

  it('groups a stream into batches', async () => {
    async function* numbers() { for (let i = 1; i <= 7; i++) yield i }
    const out = []
    for await (const b of batches(numbers(), 3)) out.push(b)
    expect(out).toEqual([[1, 2, 3], [4, 5, 6], [7]])
  })
})

describe('key lookup', () => {
  const pg = knexlib({ client: 'pg' })
  const mssql = knexlib({ client: 'mssql' })
  const sqlite = knexlib({ client: 'better-sqlite3', useNullAsDefault: true })

  it('uses IN for a single key', () => {
    expect(keyLookupQuery(pg, 'postgresql', { table: 'users', schema: 'public' }, ['id'], [[1], [2]]))
      .toBe('select "id" as "k0" from "public"."users" where "id" in (1, 2)')
  })

  it('uses tuple IN for composite keys where supported', () => {
    expect(keyLookupQuery(pg, 'postgresql', { table: 't' }, ['a', 'b'], [[1, 'x'], [2, 'y']]))
      .toBe('select "a" as "k0", "b" as "k1" from "t" where ("a", "b") in ((1, \'x\'), (2, \'y\'))')
    expect(keyLookupQuery(sqlite, 'sqlite', { table: 't' }, ['a', 'b'], [[1, 'x']]))
      .toBe("select `a` as `k0`, `b` as `k1` from `t` where (`a`, `b`) in ( values (1, 'x'))")
  })

  it('uses OR of AND groups on SQL Server', () => {
    expect(keyLookupQuery(mssql, 'sqlserver', { table: 't', schema: 'dbo' }, ['a', 'b'], [[1, 'x'], [2, "o'k"]]))
      .toBe("select [a] as [k0], [b] as [k1] from [dbo].[t] where (([a] = 1 and [b] = 'x') or ([a] = 2 and [b] = 'o''k'))")
  })

  it('matches file values to values returned by drivers', () => {
    expect(normalizeKeyPart(5)).toBe(normalizeKeyPart('5'))
    expect(normalizeKeyPart('12.50')).toBe(normalizeKeyPart(12.5))
    expect(normalizeKeyPart('007')).toBe('7')
    expect(normalizeKeyPart(true)).toBe(normalizeKeyPart(1))
    expect(normalizeKeyPart(new Date(2024, 0, 31))).toBe('2024-01-31')
    expect(normalizeKeyPart('2024-01-31 00:00:00')).toBe('2024-01-31')
    expect(normalizeKeyPart(new Date(2024, 0, 31, 8, 5, 1))).toBe(normalizeKeyPart('2024-01-31T08:05:01'))
    expect(keyString([1, null])).toBeNull()
  })

  it('falls back to a case-insensitive match only when it is unambiguous', () => {
    const existing = new ExistingKeys()
    existing.add(keyString(['ABC']))
    expect(existing.has(keyString(['abc']))).toBe(true)
    existing.add(keyString(['Abc']))
    expect(existing.has(keyString(['abc']))).toBe(false)
    expect(existing.has(keyString(['Abc']))).toBe(true)
  })
})

describe('modes per database', () => {
  it('disables Update and Append without update on Cassandra, with a reason', () => {
    const s = importSupport('cassandra')
    expect(s.modes.filter((m) => !m.enabled).map((m) => m.mode)).toEqual(['update', 'appendNoUpdate'])
    expect(s.modes.find((m) => m.mode === 'update').note).toMatch(/always overwrite/)
    expect(s.transactions).toBe(false)
  })

  it('offers every mode on ClickHouse without transactions, warning about mutations', () => {
    const s = importSupport('clickhouse')
    expect(s.modes.every((m) => m.enabled)).toBe(true)
    expect(s.modes.find((m) => m.mode === 'appendUpdate').note).toMatch(/mutations/)
    expect(s.transactions).toBe(false)
    expect(s.warnings.join()).toMatch(/can't be rolled back/)
  })

  it('warns about DML quotas on BigQuery', () => {
    expect(importSupport('bigquery').warnings.join()).toMatch(/DML quotas/)
  })

  it('offers all six modes in a transaction on the other databases', () => {
    for (const d of Dialects.filter((d) => !['cassandra', 'clickhouse', 'bigquery'].includes(d))) {
      const s = importSupport(d)
      expect(s.transactions).toBe(true)
      expect(ImportModes.every((m) => isModeEnabled(d, m))).toBe(true)
      expect(s.warnings).toEqual([])
    }
  })
})

describe('mapping and validation', () => {
  const options = (extra: Partial<ImportOptions> = {}): ImportOptions => ({
    mode: 'append', keyColumns: [], useTransaction: true, batchSize: 500, errorMode: 'stop',
    decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', emptyAsNull: true, ...extra,
  })
  const columns = [
    { name: 'id', dataType: 'int', nullable: false, hasDefault: true },
    { name: 'email', dataType: 'text', nullable: false, hasDefault: false },
    { name: 'note', dataType: 'text', nullable: true },
  ]

  it('maps by case-insensitive name and skips unknown file columns', () => {
    expect(autoMap(['Id', 'email', 'Extra'], ['id', 'email'])).toEqual([
      { fileIndex: 0, fileColumn: 'Id', tableColumn: 'id' },
      { fileIndex: 1, fileColumn: 'email', tableColumn: 'email' },
      { fileIndex: 2, fileColumn: 'Extra', tableColumn: null },
    ])
  })

  it('warns when a required column is unmapped in a mode that inserts', () => {
    const mapping = autoMap(['id', 'note'], ['id', 'email', 'note'])
    expect(importWarnings('postgresql', mapping, columns, options()).join()).toMatch(/aren't mapped: email/)
    expect(importWarnings('postgresql', mapping, columns, options({ mode: 'delete', keyColumns: ['id'] }))).toEqual([])
  })

  it('requires key columns for keyed modes', () => {
    const mapping = autoMap(['id', 'email'], ['id', 'email', 'note'])
    expect(validateImport('postgresql', mapping, columns, options({ mode: 'update' })).join())
      .toMatch(/Update needs at least one key column/)
    expect(validateImport('postgresql', mapping, columns, options({ mode: 'update', keyColumns: ['note'] })).join())
      .toMatch(/Key columns must be mapped: note/)
    expect(validateImport('postgresql', mapping, columns, options({ mode: 'update', keyColumns: ['id'] }))).toEqual([])
  })

  it('needs a column to update besides the keys', () => {
    const mapping = autoMap(['id'], ['id', 'email'])
    expect(validateImport('postgresql', mapping, columns, options({ mode: 'appendUpdate', keyColumns: ['id'] })).join())
      .toMatch(/something to update/)
  })

  it('refuses a mode the database cannot do', () => {
    const mapping = autoMap(['id', 'email'], ['id', 'email'])
    expect(validateImport('cassandra', mapping, columns, options({ mode: 'update', keyColumns: ['id'] })).join())
      .toMatch(/can't import in Update mode/)
  })
})

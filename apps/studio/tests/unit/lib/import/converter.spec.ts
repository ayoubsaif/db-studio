import { convertValue, createConverter, valueKind } from '@/lib/import/converter'
import { ConvertOptions } from '@/lib/import/types'

const opts = (extra: Partial<ConvertOptions> = {}): ConvertOptions => ({
  decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', emptyAsNull: true, ...extra,
})

describe('column type classification', () => {
  it.each([
    ['integer', 'integer'], ['bigint', 'integer'], ['int(11)', 'integer'], ['UInt64', 'integer'], ['Nullable(Int32)', 'integer'],
    ['serial', 'integer'], ['tinyint(1)', 'integer'],
    ['numeric(10,2)', 'decimal'], ['Decimal(10, 2)', 'decimal'], ['double precision', 'decimal'], ['NUMBER', 'decimal'], ['money', 'decimal'],
    ['boolean', 'boolean'], ['bit', 'boolean'], ['Bool', 'boolean'],
    ['date', 'date'], ['Date32', 'date'],
    ['timestamp without time zone', 'datetime'], ['datetime2', 'datetime'], ['DateTime64(3)', 'datetime'],
    ['time without time zone', 'time'],
    ['character varying(255)', 'string'], ['LowCardinality(String)', 'string'], ['interval', 'string'], ['point', 'string'], ['jsonb', 'string'],
  ])('%s is %s', (type, kind) => {
    expect(valueKind(type)).toBe(kind)
  })
})

describe('value conversion', () => {
  it('reads integers, keeping values beyond 2^53 exact', () => {
    expect(convertValue('42', 'integer', opts())).toBe(42)
    expect(convertValue(' -7 ', 'integer', opts())).toBe(-7)
    expect(convertValue('18446744073709551615', 'integer', opts())).toBe('18446744073709551615')
    expect(convertValue(12, 'integer', opts())).toBe(12)
  })

  it('rejects text and fractions for integer columns', () => {
    expect(() => convertValue('abc', 'integer', opts())).toThrow('is not a number')
    expect(() => convertValue('1.5', 'integer', opts())).toThrow('is not a whole number')
    expect(() => convertValue(1.5, 'integer', opts())).toThrow('is not a whole number')
  })

  it('reads decimals with a decimal comma and thousands separators', () => {
    const comma = opts({ decimalSeparator: ',' })
    expect(convertValue('12,5', 'decimal', comma)).toBe(12.5)
    expect(convertValue('1.234,50', 'decimal', comma)).toBe(1234.5)
    expect(convertValue('1,234.5', 'decimal', opts())).toBe(1234.5)
    expect(convertValue('.5', 'decimal', opts())).toBe(0.5)
    expect(convertValue('1e3', 'decimal', opts())).toBe(1000)
    // more digits than a JS number holds stay as text
    expect(convertValue('0.12345678901234567890', 'decimal', opts())).toBe('0.12345678901234567890')
    expect(() => convertValue('12.5', 'decimal', comma)).toThrow('is not a number')
  })

  it('reads booleans in common spellings', () => {
    for (const t of ['true', 'TRUE', 'yes', 'Y', '1', 't', 'on', true, 1]) expect(convertValue(t as any, 'boolean', opts())).toBe(true)
    for (const f of ['false', 'No', 'n', '0', 'f', 'off', false, 0]) expect(convertValue(f as any, 'boolean', opts())).toBe(false)
    expect(() => convertValue('maybe', 'boolean', opts())).toThrow('is not true or false')
  })

  it('reads dates in the chosen format and always accepts ISO dates', () => {
    const dmy = opts({ dateFormat: 'DD/MM/YYYY' })
    expect(convertValue('31/01/2024', 'date', dmy)).toBe('2024-01-31')
    expect(convertValue('2024-01-31', 'date', dmy)).toBe('2024-01-31')
    expect(convertValue('31/01/2024 14:30', 'datetime', dmy)).toBe('2024-01-31 14:30:00')
    expect(convertValue('2024-01-31T14:30:05.250Z', 'datetime', dmy)).toBe('2024-01-31 14:30:05.250+00:00')
    expect(convertValue('1/2/24', 'date', opts({ dateFormat: 'M/D/YY' }))).toBe('2024-01-02')
  })

  it('rejects dates that do not exist or do not match', () => {
    const dmy = opts({ dateFormat: 'DD/MM/YYYY' })
    expect(() => convertValue('31/02/2024', 'date', dmy)).toThrow(/date format DD\/MM\/YYYY/)
    expect(() => convertValue('2023-02-29', 'date', dmy)).toThrow('is not a valid date')
    expect(() => convertValue('next week', 'date', dmy)).toThrow(/date format/)
  })

  it('reads Excel day numbers and time fractions', () => {
    expect(convertValue(45322, 'date', opts())).toBe('2024-01-31')
    expect(convertValue(0.5, 'time', opts())).toBe('12:00:00')
    expect(convertValue('08:15', 'time', opts())).toBe('08:15')
  })

  it('turns empty values into NULL, or keeps empty text when that is off', () => {
    expect(convertValue('', 'integer', opts())).toBeNull()
    expect(convertValue('  ', 'string', opts())).toBeNull()
    expect(convertValue('', 'string', opts({ emptyAsNull: false }))).toBe('')
    expect(() => convertValue('', 'integer', opts({ emptyAsNull: false }))).toThrow('is empty')
    expect(convertValue(null, 'integer', opts({ emptyAsNull: false }))).toBeNull()
  })

  it('writes numbers from Excel into text columns as text', () => {
    expect(convertValue(12, 'string', opts())).toBe('12')
  })
})

describe('row converter', () => {
  const columns = [
    { name: 'id', dataType: 'integer' },
    { name: 'price', dataType: 'numeric(10,2)' },
    { name: 'name', dataType: 'text' },
  ]
  const mappings = [
    { fileIndex: 0, fileColumn: 'Id', tableColumn: 'id' },
    { fileIndex: 1, fileColumn: 'Extra', tableColumn: null },
    { fileIndex: 2, fileColumn: 'Price', tableColumn: 'price' },
  ]

  it('converts mapped columns and skips the rest', () => {
    const c = createConverter(mappings, columns, opts({ decimalSeparator: ',' }))
    expect(c.columns).toEqual(['id', 'price'])
    expect(c.convert({ rowNumber: 2, values: ['5', 'ignored', '9,99'] })).toEqual({
      row: { rowNumber: 2, values: { id: 5, price: 9.99 } }, errors: [],
    })
  })

  it('reports every bad value of a row with the column and value', () => {
    const c = createConverter(mappings, columns, opts())
    const { row, errors } = c.convert({ rowNumber: 7, values: ['abc', '', 'x'] })
    expect(row).toBeNull()
    expect(errors.map((e) => [e.rowNumber, e.column, e.value])).toEqual([[7, 'id', 'abc'], [7, 'price', 'x']])
    expect(errors[0].message).toBe('Column id: "abc" is not a number')
  })

  it('treats missing trailing cells as empty', () => {
    const c = createConverter(mappings, columns, opts())
    expect(c.convert({ rowNumber: 3, values: ['1'] }).row.values).toEqual({ id: 1, price: null })
  })

  it('refuses a mapping to an unknown or repeated column', () => {
    expect(() => createConverter([{ fileIndex: 0, fileColumn: 'a', tableColumn: 'nope' }], columns, opts())).toThrow(/not in the table/)
    expect(() => createConverter([
      { fileIndex: 0, fileColumn: 'a', tableColumn: 'id' }, { fileIndex: 1, fileColumn: 'b', tableColumn: 'id' },
    ], columns, opts())).toThrow(/mapped more than once/)
  })
})

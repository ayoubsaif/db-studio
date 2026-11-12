import { XlsxExporter, XLSX_MAX_CELL_LENGTH } from '@/lib/export/formats/xlsx'

function exporter(outputOptions = {}, table: any = { name: 'orders' }, queryName = '') {
  return new XlsxExporter(
    './tmp/xlsx.export', { connectionType: 'postgresql' } as any, table, '', queryName, [],
    { chunkSize: 100, deleteOnAbort: false }, { header: true, ...outputOptions }
  )
}

describe('xlsx exporter cell values', () => {
  const ex = exporter()

  it('keeps nulls, booleans and numbers', () => {
    expect(ex.toCellValue(null, null, 'integer')).toBeNull()
    expect(ex.toCellValue(undefined, undefined, 'integer')).toBeNull()
    expect(ex.toCellValue(true, true, 'boolean')).toBe(true)
    expect(ex.toCellValue(42, 42, 'integer')).toBe(42)
    expect(ex.toCellValue(1.5, 1.5, 'double')).toBe(1.5)
  })

  it('turns numeric strings from numeric columns into numbers', () => {
    expect(ex.toCellValue('12.50', '12.50', 'numeric(10,2)')).toBe(12.5)
    expect(ex.toCellValue('-7', '-7', 'bigint')).toBe(-7)
    expect(ex.toCellValue('1e3', '1e3', 'float8')).toBe(1000)
  })

  it('keeps numbers as text when Excel would round them', () => {
    expect(ex.toCellValue('9007199254740993', '9007199254740993', 'bigint')).toBe('9007199254740993')
    expect(ex.toCellValue('1234567890.1234567', '1234567890.1234567', 'numeric')).toBe('1234567890.1234567')
  })

  it('leaves numeric-looking text in text columns alone', () => {
    expect(ex.toCellValue('00123', '00123', 'varchar(10)')).toBe('00123')
  })

  it('writes driver dates as local wall-clock time', () => {
    const local = new Date(2024, 0, 5, 13, 45, 10)
    const cell = ex.toCellValue(local, local.toISOString(), 'timestamp') as Date
    expect(cell).toBeInstanceOf(Date)
    expect([cell.getUTCFullYear(), cell.getUTCMonth(), cell.getUTCDate(), cell.getUTCHours(), cell.getUTCMinutes(), cell.getUTCSeconds()])
      .toEqual([2024, 0, 5, 13, 45, 10])
  })

  it('parses date strings from date columns without shifting them', () => {
    const d = ex.toCellValue('2024-02-29', '2024-02-29', 'date') as Date
    expect(d.toISOString()).toBe('2024-02-29T00:00:00.000Z')
    const dt = ex.toCellValue('2024-01-05 13:45:10.5', '2024-01-05 13:45:10.5', 'datetime') as Date
    expect(dt.toISOString()).toBe('2024-01-05T13:45:10.500Z')
  })

  it('keeps impossible or zoned date strings as text', () => {
    expect(ex.toCellValue('2024-02-31', '2024-02-31', 'date')).toBe('2024-02-31')
    expect(ex.toCellValue('2024-01-05 13:45:10+02', '2024-01-05 13:45:10+02', 'timestamptz')).toBe('2024-01-05 13:45:10+02')
    expect(ex.toCellValue('13:45:10', '13:45:10', 'time')).toBe('13:45:10')
  })

  it('writes objects as JSON text', () => {
    expect(ex.toCellValue({ a: 1 }, '{"a":1}', 'jsonb')).toBe('{"a":1}')
  })

  it('cuts text longer than the Excel cell limit and counts it', () => {
    const local = exporter()
    const long = 'x'.repeat(XLSX_MAX_CELL_LENGTH + 10)
    const cell = local.toCellValue(long, long, 'text') as string
    expect(cell.length).toBe(XLSX_MAX_CELL_LENGTH)
    expect(local.truncatedCells).toBe(1)
  })

  it('reports cut cells as a warning', () => {
    const local = exporter()
    expect(local.warnings()).toEqual([])
    const long = 'x'.repeat(XLSX_MAX_CELL_LENGTH + 1)
    local.toCellValue(long, long, 'text')
    expect(local.warnings()).toEqual(["1 cell was longer than Excel's 32,767 character limit and got cut."])
    local.toCellValue(long, long, 'text')
    expect(local.warnings()[0]).toMatch(/^2 cells were/)
  })
})

describe('xlsx exporter sheet names', () => {
  it('uses the table name, then numbered sheets', () => {
    const ex = exporter()
    expect(ex.sheetName(1)).toBe('orders')
    expect(ex.sheetName(2)).toBe('orders (2)')
  })

  it('removes characters Excel rejects and keeps 31 characters', () => {
    const ex = exporter({}, { name: 'a/b\\c?d*e[f]g:h' + 'z'.repeat(40) })
    expect(ex.sheetName(1)).toMatch(/^a_b_c_d_e_f_g_h/)
    expect(ex.sheetName(1).length).toBe(31)
    expect(ex.sheetName(12).length).toBe(31)
    expect(ex.sheetName(12).endsWith(' (12)')).toBe(true)
  })

  it('prefers the sheet name option, then the query name', () => {
    expect(exporter({ sheetName: 'Report' }).sheetName(1)).toBe('Report')
    expect(exporter({}, null, 'Query #1').sheetName(1)).toBe('Query #1')
  })
})

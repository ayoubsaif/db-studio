import fs from 'fs'
import os from 'os'
import path from 'path'
import * as ExcelJS from 'exceljs'
import { readFileRows, sampleFile, listSheets } from '@/lib/import/readers'
import { ParseOptions } from '@/lib/import/types'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-import-'))
const file = (name: string, content: string | Buffer) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

async function all(p: string, parse: ParseOptions) {
  const rows = []
  for await (const r of readFileRows(p, parse)) rows.push(r)
  return rows
}

const csv = (extra: Partial<ParseOptions> = {}): ParseOptions => ({ format: 'csv', headerRow: 1, csv: {}, ...extra })

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('CSV reader', () => {
  it('reads quoted fields with delimiters, quotes and line breaks', async () => {
    const p = file('quoted.csv', 'id,note\n1,"a, b"\n2,"say ""hi"""\n3,"two\nlines"\n')
    const rows = await all(p, csv())
    expect(rows.map((r) => r.values)).toEqual([['1', 'a, b'], ['2', 'say "hi"'], ['3', 'two\nlines']])
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3, 4])
  })

  it('handles CRLF line endings and a UTF-8 byte order mark', async () => {
    const p = file('crlf.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Id,Name\r\n1,Ana\r\n2,Bo\r\n')]))
    const sample = await sampleFile(p, csv())
    expect(sample.columns).toEqual(['Id', 'Name'])
    expect(sample.rows.map((r) => r.values)).toEqual([['1', 'Ana'], ['2', 'Bo']])
  })

  it('decodes a non-UTF-8 file in the chosen encoding', async () => {
    // "café;crème" in windows-1252
    const p = file('latin.csv', Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x3b, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x0a]))
    const rows = await all(p, csv({ csv: { encoding: 'windows-1252', delimiter: ';' } }))
    expect(rows[0].values).toEqual(['café', 'crème'])
  })

  it('reads UTF-16 with a byte order mark', async () => {
    const p = file('utf16.csv', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n1,ü\n', 'utf16le')]))
    const rows = await all(p, csv({ csv: { encoding: 'utf-16le' } }))
    expect(rows[0].values).toEqual(['1', 'ü'])
  })

  it('uses a custom delimiter and quote character', async () => {
    const p = file('custom.csv', "a|b\n'x|y'|z\n")
    const rows = await all(p, csv({ csv: { delimiter: '|', quoteChar: "'" } }))
    expect(rows[0].values).toEqual(['x|y', 'z'])
  })

  it('names columns Column 1, Column 2 without a header and imports the first row', async () => {
    const p = file('noheader.csv', '1,a\n2,b\n')
    const sample = await sampleFile(p, csv({ headerRow: null }))
    expect(sample.columns).toEqual(['Column 1', 'Column 2'])
    expect(sample.rows.map((r) => r.values[0])).toEqual(['1', '2'])
  })

  it('reads only the chosen first to last data rows and skips blank lines', async () => {
    const p = file('range.csv', 'title line\nid\n1\n\n2\n3\n4\n')
    const rows = await all(p, csv({ headerRow: 2, firstDataRow: 3, lastDataRow: 6 }))
    expect(rows.map((r) => [r.rowNumber, r.values[0]])).toEqual([[3, '1'], [5, '2'], [6, '3']])
  })

  it('reports an unknown encoding', async () => {
    const p = file('enc.csv', 'a\n1\n')
    await expect(all(p, csv({ csv: { encoding: 'no-such-encoding' } }))).rejects.toThrow(/Unknown encoding/)
  })
})

describe('XLSX reader', () => {
  let workbookPath: string

  beforeAll(async () => {
    const wb = new ExcelJS.Workbook()
    const jan = wb.addWorksheet('Jan')
    jan.addRow(['id', 'name'])
    jan.addRow([1, 'january'])
    const feb = wb.addWorksheet('Feb')
    feb.addRow(['id', 'sold_on', 'stamp', 'double', 'rich', 'flag'])
    const row = feb.addRow([7, new Date(Date.UTC(2024, 1, 29)), new Date(Date.UTC(2024, 1, 29, 13, 5, 9)), { formula: 'A2*2', result: 14 }, null, true])
    row.getCell(5).value = { richText: [{ text: 'bold ' }, { text: 'text' }] }
    feb.getCell('B2').numFmt = 'yyyy-mm-dd'
    feb.getCell('C2').numFmt = 'yyyy-mm-dd hh:mm:ss'
    feb.addRow([])
    feb.addRow([8, null, null, null, 'after a blank row'])
    workbookPath = path.join(dir, 'months.xlsx')
    await wb.xlsx.writeFile(workbookPath)
  })

  it('lists worksheets in workbook order', async () => {
    expect(await listSheets(workbookPath)).toEqual(['Jan', 'Feb'])
  })

  it('reads the chosen worksheet with dates, formula results and rich text', async () => {
    const sample = await sampleFile(workbookPath, { format: 'xlsx', sheet: 'Feb', headerRow: 1 })
    expect(sample.sheets).toEqual(['Jan', 'Feb'])
    expect(sample.columns).toEqual(['id', 'sold_on', 'stamp', 'double', 'rich', 'flag'])
    expect(sample.rows[0].values).toEqual([7, '2024-02-29', '2024-02-29 13:05:09', 14, 'bold text', true])
    // Excel's own row numbers, blank row skipped
    expect(sample.rows.map((r) => r.rowNumber)).toEqual([2, 4])
  })

  it('reads the first worksheet when none is chosen', async () => {
    const sample = await sampleFile(workbookPath, { format: 'xlsx', headerRow: 1 })
    expect(sample.rows[0].values).toEqual([1, 'january'])
  })

  it('applies first and last data rows', async () => {
    const rows = await all(workbookPath, { format: 'xlsx', sheet: 'Feb', headerRow: 1, firstDataRow: 3, lastDataRow: 10 })
    expect(rows.map((r) => r.values[0])).toEqual([8])
  })

  it("says a corrupt or password-protected file can't be read", async () => {
    const p = file('broken.xlsx', Buffer.from('this is not a zip file at all, just text'))
    await expect(listSheets(p)).rejects.toThrow(/can't be read/)
    await expect(sampleFile(p, { format: 'xlsx', headerRow: 1 })).rejects.toThrow(/can't be read/)
  })

  it('reports a missing worksheet', async () => {
    await expect(all(workbookPath, { format: 'xlsx', sheet: 'Mar', headerRow: 1 })).rejects.toThrow(/Worksheet "Mar" not found/)
  })
})

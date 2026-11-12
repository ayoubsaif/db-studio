import { DBTestUtil } from "../../../../lib/db";
import { XlsxExporter } from '../../../../../src/lib/export/formats/xlsx'
import * as ExcelJS from 'exceljs'
import tmp from 'tmp'
import fs from 'fs'

async function readWorkbook(filename) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filename)
  return workbook
}

function sheetValues(sheet) {
  const rows = []
  sheet.eachRow((row) => rows.push(row.values.slice(1)))
  return rows
}

describe("XLSX Exporter", () => {
  let dbfile;
  let util

  beforeAll(async () => {
    dbfile = tmp.fileSync()
    util = new DBTestUtil({ client: 'sqlite' }, dbfile.name, { dialect: 'sqlite' })
    util.extraTables = 1
    await util.setupdb()
    await util.knex.schema.createTable("toexport", (t) => {
      t.integer("id")
      t.string("name")
      t.decimal("price", 10, 2)
      t.date("sold_on")
    })
    await util.knex("toexport").insert([
      { id: 1, name: 'foo', price: 12.5, sold_on: '2024-01-05' },
      { id: 2, name: 'bar', price: 3, sold_on: '2024-02-29' },
      { id: 3, name: 'ba\nz', price: null, sold_on: null },
    ]);
  })

  afterAll(async () => {
    await util.disconnect()
  })

  function makeExporter(filename, outputOptions = { header: true }, chunkSize = 1) {
    return new XlsxExporter(
      filename,
      util.connection,
      { name: 'toexport' },
      '',
      '',
      [],
      { deleteOnAbort: true, chunkSize },
      outputOptions
    )
  }

  it("writes a typed sheet with a header", async () => {
    const filename = tmp.tmpNameSync({ postfix: '.xlsx' })
    const exporter = makeExporter(filename)
    await exporter.exportToFile()
    expect(exporter.error).toBeNull()

    const workbook = await readWorkbook(filename)
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['toexport'])
    const rows = sheetValues(workbook.worksheets[0])
    expect(rows[0]).toEqual(['id', 'name', 'price', 'sold_on'])
    expect(rows[1].slice(0, 3)).toEqual([1, 'foo', 12.5])
    expect(rows[1][3]).toBeInstanceOf(Date)
    expect(rows[1][3].toISOString()).toBe('2024-01-05T00:00:00.000Z')
    expect(rows[2].slice(0, 3)).toEqual([2, 'bar', 3])
    expect(rows[3].slice(0, 2)).toEqual([3, 'ba\nz'])
    expect(rows).toHaveLength(4)

    const dateCell = workbook.worksheets[0].getRow(2).getCell(4)
    expect(dateCell.numFmt).toBe('yyyy-mm-dd')
    // wide enough that Excel shows the date instead of ########
    expect(workbook.worksheets[0].getColumn(4).width).toBe(20)
    expect(workbook.worksheets[0].getColumn(1).width).toBe(10)
  })

  it("can leave out the header", async () => {
    const filename = tmp.tmpNameSync({ postfix: '.xlsx' })
    await makeExporter(filename, { header: false }).exportToFile()
    const rows = sheetValues((await readWorkbook(filename)).worksheets[0])
    expect(rows).toHaveLength(3)
    expect(rows[0][1]).toBe('foo')
  })

  it("continues on new sheets with the header repeated", async () => {
    const filename = tmp.tmpNameSync({ postfix: '.xlsx' })
    const exporter = makeExporter(filename, { header: true }, 2)
    // header + 1 data row per sheet
    exporter.maxRowsPerSheet = 2
    await exporter.exportToFile()
    expect(exporter.error).toBeNull()

    const workbook = await readWorkbook(filename)
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['toexport', 'toexport (2)', 'toexport (3)'])
    workbook.worksheets.forEach((sheet) => {
      expect(sheetValues(sheet)[0]).toEqual(['id', 'name', 'price', 'sold_on'])
    })
    expect(workbook.worksheets.map((s) => sheetValues(s)[1][0])).toEqual([1, 2, 3])
  })

  it("exports query results", async () => {
    const filename = tmp.tmpNameSync({ postfix: '.xlsx' })
    const exporter = new XlsxExporter(
      filename, util.connection, null, 'select id, name from toexport order by id', 'My Query', [],
      { deleteOnAbort: true, chunkSize: 2 }, { header: true }
    )
    await exporter.exportToFile()
    expect(exporter.error).toBeNull()
    const workbook = await readWorkbook(filename)
    expect(workbook.worksheets[0].name).toBe('My Query')
    expect(sheetValues(workbook.worksheets[0]).map((r) => r[0])).toEqual(['id', 1, 2, 3])
  })

  it("deletes the file when the export fails", async () => {
    const filename = tmp.tmpNameSync({ postfix: '.xlsx' })
    const exporter = new XlsxExporter(
      filename, util.connection, null, 'select * from missing_table', 'broken', [],
      { deleteOnAbort: true, chunkSize: 2 }, { header: true }
    )
    await exporter.exportToFile()
    expect(exporter.error).not.toBeNull()
    expect(fs.existsSync(filename)).toBe(false)
  })
})

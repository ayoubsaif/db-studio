import * as ExcelJS from 'exceljs'
import _ from 'lodash'
import { BasicDatabaseClient } from '@/lib/db/clients/BasicDatabaseClient'
import { dialectFor } from '@shared/lib/dialects/models'
import { Mutators } from '../../data/tools'
import { TableColumn, TableFilter, TableOrView } from '../../db/models'
import { Export } from '../export'
import { ExportOptions } from '../models'

export interface OutputOptionsXlsx {
  header: boolean
  sheetName?: string
}

// Excel's own limits
export const XLSX_MAX_ROWS = 1048576
export const XLSX_MAX_CELL_LENGTH = 32767
const MAX_SHEET_NAME_LENGTH = 31

const NUMERIC_TYPE = /^(tiny|small|medium|big)?int|integer|serial|decimal|numeric|real|float|double|number|money/i
const NUMERIC_STRING = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/
const DATE_TYPE = /date|time/i
// wall-clock date or datetime without a zone offset, eg 2024-01-05 or 2024-01-05 13:45:10.123
const DATE_STRING = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/
// Excel keeps 15 significant digits; longer numbers stay text so nothing is silently rounded
const MAX_EXACT_DIGITS = 15

const DATE_FORMAT = 'yyyy-mm-dd'
const DATETIME_FORMAT = 'yyyy-mm-dd hh:mm:ss'

// column widths in Excel character units; dates need room for DATETIME_FORMAT
const MIN_COLUMN_WIDTH = 10
const DATE_COLUMN_WIDTH = 20
const MAX_COLUMN_WIDTH = 50

type XlsxValue = string | number | boolean | Date | null

export class XlsxExporter extends Export {
  static extension = 'xlsx'
  readonly format: string = 'xlsx'
  rowSeparator = ''

  // tests lower this to exercise sheet rollover
  maxRowsPerSheet = XLSX_MAX_ROWS
  truncatedCells = 0

  private outputOptions: OutputOptionsXlsx
  private workbook?: ExcelJS.stream.xlsx.WorkbookWriter
  private sheet?: ExcelJS.Worksheet
  private sheetCount = 0
  private rowsInSheet = 0
  private headerValues: string[] = []

  constructor(
    filePath: string,
    connection: BasicDatabaseClient<any>,
    table: TableOrView,
    query: string,
    queryName: string,
    filters: TableFilter[] | any[],
    options: ExportOptions,
    outputOptions: OutputOptionsXlsx
  ) {
    super(filePath, connection, table, query, queryName, filters, options)
    this.outputOptions = { header: true, ...(outputOptions || {}) }
  }

  warnings(): string[] {
    if (!this.truncatedCells) return []
    const cells = this.truncatedCells === 1 ? '1 cell was' : `${this.truncatedCells} cells were`
    return [`${cells} longer than Excel's ${XLSX_MAX_CELL_LENGTH.toLocaleString('en-US')} character limit and got cut.`]
  }

  // text-format hooks are not used by this exporter
  async getHeader(): Promise<string> { return '' }
  getFooter(): string { return '' }
  formatRow(): string { return '' }

  protected async openOutput(): Promise<void> {
    this.truncatedCells = 0
    this.sheetCount = 0
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: this.filePath,
      useStyles: true,
      useSharedStrings: false,
    })
  }

  protected async writeHeader(columns: TableColumn[]): Promise<void> {
    this.headerValues = (this.dedupedColumns.length ? this.dedupedColumns : columns || [])
      .map((c) => c.columnName)
    this.startSheet()
  }

  protected async writeRows(rows: any[][]): Promise<void> {
    const dataTypes = this.columns?.map((c) => c.dataType) || []
    const dialect = dialectFor(this.connection.connectionType)
    for (const raw of rows) {
      const values = Object.values(raw)
      const mutated = Mutators.mutateRow(values, dataTypes, false, dialect)
      const cells = values.map((v, i) => this.toCellValue(v, mutated[i], dataTypes[i]))

      if (this.rowsInSheet >= this.maxRowsPerSheet) {
        await this.sheet?.commit()
        this.startSheet()
      }
      this.addRow(cells)
    }
  }

  protected async writeFooter(): Promise<void> {
    // nothing to add; the workbook is finished in closeOutput
  }

  protected async closeOutput(): Promise<void> {
    const workbook = this.workbook
    this.workbook = undefined
    this.sheet = undefined
    if (!workbook) return
    // committing the workbook also commits any open sheet and closes the file
    await workbook.commit()
  }

  private startSheet(): void {
    if (!this.workbook) throw new Error('Workbook is not open')
    this.sheetCount += 1
    this.sheet = this.workbook.addWorksheet(this.sheetName(this.sheetCount))
    // widths must be set before the first row is committed; without them
    // Excel shows date columns as ######## until the user widens them
    this.sheet.columns = this.columnWidths().map((width) => ({ width }))
    this.rowsInSheet = 0
    if (this.outputOptions.header && this.headerValues.length) {
      this.addRow(this.headerValues)
    }
  }

  private addRow(cells: XlsxValue[]): void {
    // copy into a fresh array: exceljs checks `instanceof Array`, which fails
    // for arrays built in another JS context (eg driver results under jest)
    const row = this.sheet!.addRow([...cells])
    cells.forEach((value, i) => {
      if (value instanceof Date) {
        const hasTime = value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds() || value.getUTCMilliseconds()
        row.getCell(i + 1).numFmt = hasTime ? DATETIME_FORMAT : DATE_FORMAT
      }
    })
    row.commit()
    this.rowsInSheet += 1
  }

  columnWidths(): number[] {
    const types = this.columns?.map((c) => c.dataType) || []
    return this.headerValues.map((name, i) => {
      const forDates = types[i] && DATE_TYPE.test(types[i]) ? DATE_COLUMN_WIDTH : 0
      return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, name.length + 2, forDates))
    })
  }

  sheetName(index: number): string {
    const base = (this.outputOptions.sheetName || this.table?.name || this.queryName || 'Sheet')
      .replace(/[\\/?*[\]:]/g, '_')
      .replace(/^'+|'+$/g, '')
      || 'Sheet'
    const suffix = index > 1 ? ` (${index})` : ''
    return base.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length) + suffix
  }

  /**
   * Picks the Excel cell value for one database value. `raw` is what the
   * driver returned and `mutated` is the app's usual json-friendly version
   * (bits, buffers and objects already turned into text or numbers).
   */
  toCellValue(raw: any, mutated: any, dataType?: string): XlsxValue {
    if (raw === null || raw === undefined) return null

    if (_.isDate(raw)) {
      if (isNaN(raw.getTime())) return this.text(String(raw))
      // Excel has no time zones; write the local wall-clock time the app shows
      return new Date(raw.getTime() - raw.getTimezoneOffset() * 60000)
    }

    if (typeof mutated === 'boolean') return mutated
    if (typeof mutated === 'number') {
      return Number.isFinite(mutated) ? mutated : this.text(String(mutated))
    }
    if (typeof mutated === 'bigint') {
      return this.exactNumber(mutated.toString()) ?? this.text(mutated.toString())
    }

    if (typeof mutated === 'string') {
      if (dataType && NUMERIC_TYPE.test(dataType)) {
        const num = this.exactNumber(mutated)
        if (num !== null) return num
      }
      if (dataType && DATE_TYPE.test(dataType)) {
        const date = this.wallClockDate(mutated)
        if (date) return date
      }
      return this.text(mutated)
    }

    return this.text(JSON.stringify(mutated))
  }

  private exactNumber(value: string): number | null {
    const trimmed = value.trim()
    if (!NUMERIC_STRING.test(trimmed)) return null
    const digits = trimmed.replace(/[eE].*$/, '').replace(/[-.]/g, '').replace(/^0+/, '')
    if (digits.length > MAX_EXACT_DIGITS) return null
    const num = Number(trimmed)
    return Number.isFinite(num) ? num : null
  }

  private wallClockDate(value: string): Date | null {
    const m = DATE_STRING.exec(value.trim())
    if (!m) return null
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0'] = m
    const ms = Number(frac.padEnd(3, '0').slice(0, 3))
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms))
    // reject impossible dates such as 2024-02-31 instead of letting them roll over
    if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null
    return date
  }

  private text(value: string): string {
    if (value.length > XLSX_MAX_CELL_LENGTH) {
      this.truncatedCells += 1
      return value.slice(0, XLSX_MAX_CELL_LENGTH)
    }
    return value
  }
}

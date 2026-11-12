import * as ExcelJS from 'exceljs'
// exceljs's own zip library, used to read single parts of the workbook
import unzipper from 'unzipper'
import { FileRow, FileValue } from '../types'

const readerOptions: any = {
  sharedStrings: 'cache',
  hyperlinks: 'ignore',
  // styles are needed to tell date cells from plain numbers
  styles: 'cache',
  worksheets: 'emit',
  entries: 'emit',
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, '0')
}

/**
 * Excel stores dates without a time zone. exceljs returns them as UTC, so the
 * UTC parts are the wall-clock value the user typed.
 */
export function excelDateToString(date: Date): string {
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const ms = date.getUTCMilliseconds()
  if (!date.getUTCHours() && !date.getUTCMinutes() && !date.getUTCSeconds() && !ms) return day
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  return `${day} ${time}${ms ? '.' + pad(ms, 3) : ''}`
}

/** Turns an exceljs cell value into a plain value. */
export function cellValue(value: any): FileValue {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return excelDateToString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'object') {
    // formula: use the cached result
    if ('formula' in value || 'sharedFormula' in value) return cellValue(value.result)
    if ('richText' in value) return value.richText.map((part) => part.text).join('')
    if ('hyperlink' in value) return cellValue(value.text)
    if ('error' in value) return value.error
    if ('text' in value) return String(value.text)
  }
  return String(value)
}

/**
 * Opens a streaming reader with the workbook, its relationships and styles
 * already loaded. exceljs writes worksheets before workbook.xml, and the
 * streaming reader needs those parts first to name sheets and spot dates.
 */
async function openWorkbook(filePath: string) {
  let directory
  try {
    directory = await unzipper.Open.file(filePath)
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'EACCES') throw e
    // not a zip: damaged, password-protected (those are OLE files) or not Excel at all
    throw unreadable(new Error(`not a zip file: ${e?.message || e}`))
  }
  const part =(name: string) => directory.files.find((f) => f.path === name)
  const workbook = part('xl/workbook.xml')
  if (!workbook) throw unreadable(new Error('no workbook part found'))
  const reader = new (ExcelJS as any).stream.xlsx.WorkbookReader(filePath, readerOptions)
  const rels = part('xl/_rels/workbook.xml.rels')
  if (rels) await reader._parseRels(rels.stream())
  await reader._parseWorkbook(workbook.stream())
  const styles = part('xl/styles.xml')
  if (styles) await reader._parseStyles(styles.stream())
  return reader
}

function unreadable(e: any): Error {
  const message = e?.message || String(e)
  if (/central directory|signature|zip|corrupt|encrypt|no workbook part/i.test(message)) {
    return new Error(`This file can't be read as an Excel workbook (.xlsx). It may be damaged or password-protected. (${message})`)
  }
  return e instanceof Error ? e : new Error(message)
}

/** Lists worksheet names in workbook order without reading the sheets. */
export async function listSheets(filePath: string): Promise<string[]> {
  const reader = await openWorkbook(filePath)
  const sheets = (reader.model?.sheets || []).map((sheet) => sheet.name)
  if (!sheets.length) throw unreadable(new Error('no worksheets found'))
  return sheets
}

/** Streams the rows of one worksheet (the first one when `sheet` is empty). Row numbers are Excel's. */
export async function* xlsxRecords(filePath: string, sheet?: string): AsyncGenerator<FileRow> {
  const reader = await openWorkbook(filePath)
  let found = false
  try {
    for await (const worksheet of reader) {
      // sheets that aren't read are skipped by the reader
      if (sheet && worksheet.name !== sheet) continue
      found = true
      for await (const row of worksheet) {
        // row.values is 1-based and sparse
        const raw: any[] = row.values || []
        const values: FileValue[] = []
        for (let i = 1; i < raw.length; i++) values.push(cellValue(raw[i]))
        yield { rowNumber: row.number, values }
      }
      break
    }
  } catch (e) {
    throw unreadable(e)
  } finally {
    reader.stream?.destroy?.()
  }
  if (!found) throw new Error(sheet ? `Worksheet "${sheet}" not found` : 'The workbook has no worksheets')
}

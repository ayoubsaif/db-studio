import { FileRow, FileSample, FileValue, ParseOptions } from '../types'
import { csvRecords } from './csv'
import { listSheets, xlsxRecords } from './xlsx'

export { listSheets } from './xlsx'

function records(filePath: string, parse: ParseOptions): AsyncGenerator<FileRow> {
  return parse.format === 'xlsx'
    ? xlsxRecords(filePath, parse.sheet)
    : csvRecords(filePath, parse.csv)
}

export function firstDataRow(parse: ParseOptions): number {
  if (parse.firstDataRow) return parse.firstDataRow
  return parse.headerRow ? parse.headerRow + 1 : 1
}

function isBlank(values: FileValue[]) {
  return values.every((v) => v === null || v === undefined || v === '')
}

export function columnNames(header: FileValue[] | null, width: number): string[] {
  const names: string[] = []
  for (let i = 0; i < width; i++) {
    const name = header && header[i] !== null && header[i] !== undefined ? String(header[i]).trim() : ''
    names.push(name || `Column ${i + 1}`)
  }
  return names
}

/** Streams the data rows the user chose, skipping blank rows. */
export async function* readFileRows(filePath: string, parse: ParseOptions): AsyncGenerator<FileRow> {
  const first = firstDataRow(parse)
  const last = parse.lastDataRow || null
  for await (const record of records(filePath, parse)) {
    if (last && record.rowNumber > last) break
    if (record.rowNumber < first || isBlank(record.values)) continue
    yield record
  }
}

/** Reads the header and the first `limit` data rows, for the wizard. */
export async function sampleFile(filePath: string, parse: ParseOptions, limit = 20): Promise<FileSample> {
  const sheets = parse.format === 'xlsx' ? await listSheets(filePath) : undefined
  const first = firstDataRow(parse)
  const last = parse.lastDataRow || null
  let header: FileValue[] | null = null
  const rows: FileRow[] = []
  for await (const record of records(filePath, parse)) {
    if (parse.headerRow && record.rowNumber === parse.headerRow) header = record.values
    if (last && record.rowNumber > last) break
    if (record.rowNumber >= first && !isBlank(record.values)) rows.push(record)
    if (rows.length >= limit && (!parse.headerRow || header || record.rowNumber > parse.headerRow)) break
  }
  const width = Math.max(header ? header.length : 0, ...rows.map((r) => r.values.length), 0)
  return { columns: columnNames(header, width), rows, sheets }
}

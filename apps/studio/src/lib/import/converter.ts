import { ColumnMapping, ConvertOptions, FileRow, FileValue, RowError, TargetColumn } from './types'

export type ValueKind = 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'time' | 'string'

/** Strips wrappers such as Nullable(...) and LowCardinality(...) and lowercases. */
function baseType(dataType: string): string {
  let t = (dataType || '').trim().toLowerCase()
  for (;;) {
    const m = t.match(/^(nullable|lowcardinality)\((.*)\)$/)
    if (!m) break
    t = m[2].trim()
  }
  return t
}

/** Classifies a database column type. Unknown types are treated as text and passed through. */
export function valueKind(dataType: string): ValueKind {
  const t = baseType(dataType)
  if (/^(bool|boolean|bit)$/.test(t)) return 'boolean'
  if (/^u?int\d+$/.test(t) || /\b(tiny|small|medium|big)?int(eger)?\d*\b|serial\b/.test(t)) return 'integer'
  if (/decimal|numeric|number|real|float|double|money/.test(t)) return 'decimal'
  if (/timestamp|datetime/.test(t)) return 'datetime'
  if (/^date(32)?$/.test(t)) return 'date'
  if (/^time\b/.test(t)) return 'time'
  return 'string'
}

class ConvertError extends Error {}

const intPattern = /^[+-]?\d+$/

function toNumberOrString(normalized: string): number | string {
  const n = Number(normalized)
  if (!Number.isFinite(n)) throw new ConvertError('is not a number')
  if (intPattern.test(normalized)) return Number.isSafeInteger(n) ? n : normalized.replace(/^\+/, '')
  // keep the exact text when a JS number would change it, for example many decimal places
  const canonical = normalized.replace(/^\+/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return String(n) === canonical ? n : normalized.replace(/^\+/, '')
}

export function parseDecimal(text: string, separator: '.' | ','): number | string {
  const s = text.trim().replace(/\s+/g, '')
  if (/^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i.test(s) && separator === '.') {
    const n = Number(s)
    if (!Number.isFinite(n)) throw new ConvertError('is not a number')
    return n
  }
  const thousands = separator === ',' ? '\\.' : ','
  const sep = separator === ',' ? ',' : '\\.'
  const grouped = new RegExp(`^[+-]?\\d{1,3}(${thousands}\\d{3})+(${sep}\\d+)?$`)
  const plain = new RegExp(`^[+-]?(\\d+(${sep}\\d*)?|${sep}\\d+)$`)
  let normalized: string
  if (plain.test(s)) normalized = s
  else if (grouped.test(s)) normalized = s.replace(new RegExp(thousands, 'g'), '')
  else throw new ConvertError('is not a number')
  if (separator === ',') normalized = normalized.replace(',', '.')
  if (normalized.startsWith('.') || /^[+-]\./.test(normalized)) normalized = normalized.replace('.', '0.')
  return toNumberOrString(normalized)
}

export function parseInteger(value: FileValue, separator: '.' | ','): number | string {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new ConvertError('is not a whole number')
    return value
  }
  const parsed = parseDecimal(String(value), separator)
  const text = String(parsed)
  if (!intPattern.test(text)) throw new ConvertError('is not a whole number')
  return parsed
}

const trueWords = new Set(['true', 't', 'yes', 'y', '1', 'on'])
const falseWords = new Set(['false', 'f', 'no', 'n', '0', 'off'])

export function parseBoolean(value: FileValue): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  const s = String(value).trim().toLowerCase()
  if (trueWords.has(s)) return true
  if (falseWords.has(s)) return false
  throw new ConvertError('is not true or false')
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, '0')
}

interface DateParts { y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, zone?: string }

function validParts(p: DateParts): boolean {
  if (p.mo < 1 || p.mo > 12 || p.d < 1 || p.h > 23 || p.mi > 59 || p.s > 59) return false
  const days = new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate()
  return p.d <= days
}

const isoPattern = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i

const tokenPatterns: Record<string, [string, keyof DateParts]> = {
  YYYY: ['(\\d{4})', 'y'],
  YY: ['(\\d{2})', 'y'],
  MM: ['(\\d{2})', 'mo'],
  M: ['(\\d{1,2})', 'mo'],
  DD: ['(\\d{2})', 'd'],
  D: ['(\\d{1,2})', 'd'],
  HH: ['(\\d{2})', 'h'],
  H: ['(\\d{1,2})', 'h'],
  mm: ['(\\d{2})', 'mi'],
  ss: ['(\\d{2})', 's'],
  SSS: ['(\\d{1,3})', 'ms'],
}

const tokenRegex = /YYYY|YY|SSS|MM|M|DD|D|HH|H|mm|ss/g

function compileFormat(format: string): { regex: RegExp, fields: (keyof DateParts)[], twoDigitYear: boolean } {
  const fields: (keyof DateParts)[] = []
  let twoDigitYear = false
  let source = ''
  let last = 0
  format.replace(tokenRegex, (token, offset: number) => {
    source += format.slice(last, offset).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const [pattern, field] = tokenPatterns[token]
    if (token === 'YY') twoDigitYear = true
    source += pattern
    fields.push(field)
    last = offset + token.length
    return token
  })
  source += format.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return { regex: new RegExp(`^${source}$`), fields, twoDigitYear }
}

const formatCache = new Map<string, ReturnType<typeof compileFormat>[]>()

function formatsFor(dateFormat: string) {
  if (!formatCache.has(dateFormat)) {
    const base = dateFormat || 'YYYY-MM-DD'
    // also accept a time after the date
    const variants = [base, `${base} HH:mm:ss.SSS`, `${base} HH:mm:ss`, `${base} H:mm:ss`, `${base} HH:mm`, `${base} H:mm`]
    formatCache.set(dateFormat, variants.map(compileFormat))
  }
  return formatCache.get(dateFormat)
}

/** Excel day numbers count from 1899-12-30. */
function fromExcelSerial(serial: number): DateParts {
  const date = new Date(Math.round((serial - 25569) * 86400000))
  return {
    y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate(),
    h: date.getUTCHours(), mi: date.getUTCMinutes(), s: date.getUTCSeconds(), ms: date.getUTCMilliseconds(),
  }
}

export function parseDateParts(value: FileValue, dateFormat: string): DateParts {
  if (typeof value === 'number') return fromExcelSerial(value)
  const s = String(value).trim()
  const iso = s.match(isoPattern)
  if (iso) {
    const parts: DateParts = {
      y: +iso[1], mo: +iso[2], d: +iso[3], h: +(iso[4] || 0), mi: +(iso[5] || 0), s: +(iso[6] || 0),
      ms: iso[7] ? +iso[7].slice(0, 3).padEnd(3, '0') : 0, zone: iso[8],
    }
    if (validParts(parts)) return parts
    throw new ConvertError('is not a valid date')
  }
  for (const { regex, fields, twoDigitYear } of formatsFor(dateFormat)) {
    const m = s.match(regex)
    if (!m) continue
    const parts: DateParts = { y: 0, mo: 1, d: 1, h: 0, mi: 0, s: 0, ms: 0 }
    fields.forEach((field, i) => { (parts as any)[field] = Number(m[i + 1]) })
    if (twoDigitYear) parts.y += parts.y < 70 ? 2000 : 1900
    if (validParts(parts)) return parts
  }
  throw new ConvertError(`doesn't match the date format ${dateFormat || 'YYYY-MM-DD'}`)
}

function formatDate(p: DateParts) {
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`
}

function formatDateTime(p: DateParts) {
  const time = `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${p.ms ? '.' + pad(p.ms, 3) : ''}`
  return `${formatDate(p)} ${time}${p.zone ? p.zone.toUpperCase() === 'Z' ? '+00:00' : p.zone : ''}`
}

function hasTime(p: DateParts) {
  return !!(p.h || p.mi || p.s || p.ms)
}

export function parseTime(value: FileValue): string {
  if (typeof value === 'number') {
    // Excel stores times as a fraction of a day
    const p = fromExcelSerial(value % 1)
    return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`
  }
  const s = String(value).trim()
  const iso = s.match(/^\d{4}-\d{2}-\d{2}[ T](.+)$/)
  const time = iso ? iso[1] : s
  if (!/^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(time)) throw new ConvertError('is not a valid time')
  return time
}

function isEmpty(value: FileValue) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

export function convertValue(value: FileValue, kind: ValueKind, options: ConvertOptions): any {
  if (isEmpty(value)) {
    if (options.emptyAsNull || value === null || value === undefined) return null
    if (kind === 'string') return value
    throw new ConvertError('is empty')
  }
  switch (kind) {
    case 'integer': return parseInteger(value, options.decimalSeparator)
    case 'decimal':
      if (typeof value === 'number') return value
      if (typeof value === 'boolean') return value ? 1 : 0
      return parseDecimal(String(value), options.decimalSeparator)
    case 'boolean': return parseBoolean(value)
    case 'date': {
      const p = parseDateParts(value, options.dateFormat)
      // some databases (Oracle) keep a time in DATE columns
      return hasTime(p) ? formatDateTime(p) : formatDate(p)
    }
    case 'datetime': return formatDateTime(parseDateParts(value, options.dateFormat))
    case 'time': return parseTime(value)
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

export interface ConvertedRow {
  rowNumber: number
  values: Record<string, any>
}

export interface RowConverter {
  /** table columns written, in mapping order */
  columns: string[]
  convert(row: FileRow): { row: ConvertedRow | null, errors: RowError[] }
}

export function describeValue(value: FileValue): string {
  const text = String(value)
  return text.length > 60 ? text.slice(0, 57) + '...' : text
}

export function createConverter(mappings: ColumnMapping[], columns: TargetColumn[], options: ConvertOptions): RowConverter {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const used = mappings.filter((m) => m.tableColumn)
  const seen = new Set<string>()
  const plan = used.map((m) => {
    const column = byName.get(m.tableColumn)
    if (!column) throw new Error(`Column "${m.tableColumn}" is not in the table`)
    if (seen.has(m.tableColumn)) throw new Error(`Column "${m.tableColumn}" is mapped more than once`)
    seen.add(m.tableColumn)
    return { index: m.fileIndex, column: m.tableColumn, kind: valueKind(column.dataType) }
  })
  return {
    columns: plan.map((p) => p.column),
    convert(row: FileRow) {
      const values: Record<string, any> = {}
      const errors: RowError[] = []
      for (const p of plan) {
        const raw = p.index < row.values.length ? row.values[p.index] : null
        try {
          values[p.column] = convertValue(raw, p.kind, options)
        } catch (e) {
          if (!(e instanceof ConvertError)) throw e
          errors.push({
            rowNumber: row.rowNumber,
            column: p.column,
            value: raw,
            message: `Column ${p.column}: "${describeValue(raw)}" ${e.message}`,
          })
        }
      }
      return { row: errors.length ? null : { rowNumber: row.rowNumber, values }, errors }
    },
  }
}

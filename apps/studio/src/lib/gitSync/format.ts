import { createHash } from 'crypto'

/** The part of a saved query that is stored in a repository file. */
export interface QueryFile {
  title: string
  database: string | null
  text: string
}

const META_LINE = /^--\s*bks:(title|database):[ \t]*(.*)$/
const BLANK_DATABASE = '[blank]'
const MAX_FILE_NAME = 120

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Line endings and trailing whitespace do not count as a change. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
}

function databaseOf(database: string | null | undefined): string | null {
  return database && database !== BLANK_DATABASE ? oneLine(database) : null
}

export function hashQuery(query: QueryFile): string {
  return createHash('sha1')
    .update(`${oneLine(query.title)}\n${databaseOf(query.database) ?? ''}\n${normalizeText(query.text)}`)
    .digest('hex')
}

export function renderQueryFile(query: QueryFile): string {
  const lines = [`-- bks:title: ${oneLine(query.title)}`]
  const database = databaseOf(query.database)
  if (database) lines.push(`-- bks:database: ${database}`)
  return `${lines.join('\n')}\n\n${normalizeText(query.text)}\n`
}

/**
 * Reads a query file. Files without a header (plain SQL) take their title
 * from the file name, so any folder of .sql files can be imported.
 */
export function parseQueryFile(content: string, fileName: string): QueryFile {
  const lines = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  let title: string | null = null
  let database: string | null = null
  let index = 0
  for (; index < lines.length; index++) {
    const match = META_LINE.exec(lines[index])
    if (!match) break
    if (match[1] === 'title') title = oneLine(match[2])
    else database = databaseOf(match[2])
  }
  if (title !== null && lines[index] === '') index++
  const fallback = oneLine(fileName.replace(/\.sql$/i, ''))
  return {
    title: title || fallback,
    database,
    text: normalizeText(lines.slice(title !== null ? index : 0).join('\n')),
  }
}

/** A file name that is valid on common filesystems and unique among `taken` (compared case-insensitively). */
export function safeFileName(title: string, taken: Set<string>): string {
  let base = oneLine(title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .slice(0, MAX_FILE_NAME)
    .trim()
  if (!base) base = 'query'
  let name = `${base}.sql`
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    name = `${base} (${n}).sql`
  }
  return name
}

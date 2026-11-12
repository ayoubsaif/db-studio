import fs from 'fs'
import { Transform, TransformCallback } from 'stream'
import Papa from 'papaparse'
import { CsvParseOptions, FileRow } from '../types'

/** Decodes bytes to text in any encoding TextDecoder supports, and drops a byte order mark. */
class DecodeStream extends Transform {
  private decoder: TextDecoder

  constructor(encoding: string) {
    super({ decodeStrings: true })
    // throws a RangeError for an unknown encoding label
    this.decoder = new TextDecoder(encoding || 'utf-8')
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
    callback(null, this.decoder.decode(chunk, { stream: true }))
  }

  _flush(callback: TransformCallback) {
    callback(null, this.decoder.decode())
  }
}

/**
 * Streams the records of a CSV file. Row numbers count records from 1,
 * which matches line numbers unless a quoted field spans several lines.
 */
export async function* csvRecords(filePath: string, options: CsvParseOptions = {}): AsyncGenerator<FileRow> {
  const file = fs.createReadStream(filePath)
  let decode: DecodeStream
  try {
    decode = new DecodeStream(options.encoding)
  } catch (e) {
    file.destroy()
    throw new Error(`Unknown encoding "${options.encoding}"`)
  }
  const parser = Papa.parse(Papa.NODE_STREAM_INPUT, {
    delimiter: options.delimiter || '',
    quoteChar: options.quoteChar || '"',
    escapeChar: options.quoteChar || '"',
    skipEmptyLines: false,
  })
  const fail = (e: Error) => parser.destroy(e)
  file.on('error', fail)
  decode.on('error', fail)
  file.pipe(decode).pipe(parser)

  let rowNumber = 0
  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      rowNumber++
      yield { rowNumber, values: record }
    }
  } finally {
    file.destroy()
    decode.destroy()
    parser.destroy()
  }
}

import { hashQuery, normalizeText, parseQueryFile, renderQueryFile, safeFileName } from '@/lib/gitSync/format'

describe('query file format', () => {
  it('round-trips title, database and text', () => {
    const query = { title: 'Monthly sales', database: 'shop', text: 'SELECT 1;\nSELECT 2;' }
    const file = renderQueryFile(query)
    expect(file).toBe('-- bks:title: Monthly sales\n-- bks:database: shop\n\nSELECT 1;\nSELECT 2;\n')
    expect(parseQueryFile(file, 'whatever.sql')).toEqual(query)
  })

  it('leaves out an unset or blank database', () => {
    expect(renderQueryFile({ title: 'a', database: null, text: 'x' })).not.toContain('database')
    expect(renderQueryFile({ title: 'a', database: '[blank]', text: 'x' })).not.toContain('database')
  })

  it('takes the title from the file name when there is no header', () => {
    expect(parseQueryFile('SELECT 1\n', 'report.sql')).toEqual({ title: 'report', database: null, text: 'SELECT 1' })
  })

  it('keeps a leading comment that is not a bks header as query text', () => {
    expect(parseQueryFile('-- note\nSELECT 1', 'q.sql').text).toBe('-- note\nSELECT 1')
  })

  it('handles CRLF and a byte order mark', () => {
    const parsed = parseQueryFile('﻿-- bks:title: t\r\n\r\nSELECT 1\r\nFROM x\r\n', 'q.sql')
    expect(parsed).toEqual({ title: 't', database: null, text: 'SELECT 1\nFROM x' })
  })

  it('does not treat editor differences as changes', () => {
    const a = { title: 't', database: null, text: 'SELECT 1\r\n' }
    const b = { title: 't', database: '[blank]', text: 'SELECT 1' }
    expect(hashQuery(a)).toBe(hashQuery(b))
    expect(hashQuery(a)).not.toBe(hashQuery({ ...a, text: 'SELECT 2' }))
    expect(normalizeText('a\r\nb  \n\n')).toBe('a\nb')
  })
})

describe('safe file names', () => {
  it('replaces characters that are illegal in file names', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j', new Set())).toBe('a_b_c_d_e_f_g_h_i_j.sql')
  })
  it('cannot climb out of the folder', () => {
    const name = safeFileName('../../etc/passwd', new Set())
    expect(name).not.toContain('/')
    expect(name.startsWith('.')).toBe(false)
  })
  it('falls back for empty titles and trims trailing dots', () => {
    expect(safeFileName('   ', new Set())).toBe('query.sql')
    expect(safeFileName('name...', new Set())).toBe('name.sql')
  })
  it('avoids collisions, ignoring case', () => {
    const taken = new Set(['report.sql', 'report (2).sql'])
    expect(safeFileName('Report', taken)).toBe('Report (3).sql')
  })
})

import path from 'path'
import { exportFileName, resolveTargetPath } from '@/lib/export/multi'

describe('exportFileName', () => {
  it('uses schema and table name', () => {
    expect(exportFileName({ schema: 'public', name: 'orders' }, 'csv')).toBe('public.orders.csv')
  })

  it('leaves out an empty schema', () => {
    expect(exportFileName({ schema: undefined, name: 'orders' }, 'xlsx')).toBe('orders.xlsx')
    expect(exportFileName({ schema: '', name: 'orders' }, 'xlsx')).toBe('orders.xlsx')
  })

  it('replaces characters file systems reject', () => {
    expect(exportFileName({ schema: 'a/b', name: 'c:d*e?"f|<g>' }, 'csv')).toBe('a_b.c_d_e__f__g_.csv')
  })

  it('avoids trailing dots and reserved device names', () => {
    expect(exportFileName({ name: 'odd. ' }, 'csv')).toBe('odd.csv')
    expect(exportFileName({ name: 'CON' }, 'csv')).toBe('_CON.csv')
  })
})

describe('resolveTargetPath', () => {
  const dir = path.join('exports')
  const existing = (...names: string[]) => {
    const set = new Set(names.map((n) => path.join(dir, n)))
    return (p: string) => set.has(p)
  }

  it('overwrites when asked', () => {
    expect(resolveTargetPath(dir, 'a.csv', 'overwrite', existing('a.csv'))).toBe(path.join(dir, 'a.csv'))
  })

  it('skips existing files when asked', () => {
    expect(resolveTargetPath(dir, 'a.csv', 'skip', existing('a.csv'))).toBeNull()
    expect(resolveTargetPath(dir, 'b.csv', 'skip', existing('a.csv'))).toBe(path.join(dir, 'b.csv'))
  })

  it('adds the next free number', () => {
    expect(resolveTargetPath(dir, 'a.csv', 'number', existing('a.csv', 'a (2).csv'))).toBe(path.join(dir, 'a (3).csv'))
    expect(resolveTargetPath(dir, 'b.csv', 'number', existing('a.csv'))).toBe(path.join(dir, 'b.csv'))
  })

  it('never gives two tables in one run the same file, ignoring case', () => {
    const taken = new Set<string>()
    const none = existing()
    expect(resolveTargetPath(dir, 'Orders.csv', 'overwrite', none, taken)).toBe(path.join(dir, 'Orders.csv'))
    expect(resolveTargetPath(dir, 'orders.csv', 'overwrite', none, taken)).toBe(path.join(dir, 'orders (2).csv'))
    // skip is for files that existed before the run, not clashes inside it
    expect(resolveTargetPath(dir, 'orders.csv', 'skip', none, taken)).toBe(path.join(dir, 'orders (3).csv'))
  })

  it('numbers a clash with a file written earlier in the same run', () => {
    const taken = new Set<string>()
    const onDisk = new Set<string>()
    const exists = (p: string) => onDisk.has(p)
    const first = resolveTargetPath(dir, 'a.csv', 'overwrite', exists, taken)
    onDisk.add(first)
    expect(resolveTargetPath(dir, 'a.csv', 'overwrite', exists, taken)).toBe(path.join(dir, 'a (2).csv'))
  })
})

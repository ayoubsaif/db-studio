import { classify } from '@/lib/gitSync/classify'

describe('classify', () => {
  it.each([
    ['nothing anywhere', undefined, undefined, undefined, 'same'],
    ['only local', 'L', undefined, undefined, 'newLocal'],
    ['only local, synced before (file removed)', 'L', undefined, 'B', 'newLocal'],
    ['only in repo, never synced', undefined, 'R', undefined, 'newRepo'],
    ['removed locally after sync is not brought back', undefined, 'R', 'B', 'same'],
    ['identical', 'X', 'X', undefined, 'same'],
    ['identical with a base', 'X', 'X', 'B', 'same'],
    ['differ with no base', 'L', 'R', undefined, 'conflict'],
    ['repo changed only', 'B', 'R', 'B', 'toLocal'],
    ['local changed only', 'L', 'B', 'B', 'toRepo'],
    ['both changed', 'L', 'R', 'B', 'conflict'],
  ])('%s', (_name, local, repo, base, expected) => {
    expect(classify(local, repo, base)).toBe(expected)
  })
})

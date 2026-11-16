export type SyncAction =
  /** same content on both sides, or nothing to do */
  | 'same'
  /** the repository changed, local did not: update local */
  | 'toLocal'
  /** local changed, the repository did not: update the file */
  | 'toRepo'
  /** exists only locally */
  | 'newLocal'
  /** exists only in the repository */
  | 'newRepo'
  /** both sides changed: the user decides */
  | 'conflict'

/**
 * Three-way comparison of one query.
 * @param local hash of the local query, undefined when there is none
 * @param repo hash of the repository file, undefined when there is none
 * @param base hash at the last sync, undefined when never synced
 */
export function classify(local?: string, repo?: string, base?: string): SyncAction {
  if (local === undefined && repo === undefined) return 'same'
  if (repo === undefined) return 'newLocal'
  if (local === undefined) {
    // a query that was synced and then removed locally is not brought back
    return base === undefined ? 'newRepo' : 'same'
  }
  if (local === repo) return 'same'
  if (base === undefined) return 'conflict'
  if (local === base) return 'toLocal'
  if (repo === base) return 'toRepo'
  return 'conflict'
}

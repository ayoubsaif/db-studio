## Context

Saved queries are `favorite_query` rows (`title`, `text`, `database`, plus `connectionHash` that is `'DEPRECATED'` for local queries). The renderer talks to the utility process through `$util.send('<handler>', args)`; handler groups (`ImportHandlers`, `AppDbHandlers`, ...) are spread into `handlers` in `utility.ts`. User settings are available through the `UserSetting` model. The sidebar list is `FavoriteList.vue`. Folders for saved queries do not exist in this edition.

## Goals / Non-Goals

**Goals:**
- Round-trip saved queries through a git repository the user controls, with diffs that read well.
- Never lose a query silently: conflicts are surfaced, deletions are never propagated.
- No new dependencies and no credential handling in the app.

**Non-Goals:**
- Resolving conflicts inside a query's text (line merge). The unit of conflict is a whole query.
- Propagating deletions in either direction.
- Cloning, branch management, or any git operation beyond fetch, fast-forward pull, add, commit and push.

## Decisions

1. **System `git` through `execFile`.** Arguments are passed as an array, with no shell, and the working directory is the repository. Auth, hooks and signing behave like the user's terminal. Alternative: a JS git library. Rejected: SSH and credential helper support is weaker. If `git` is missing the handlers return a clear error.
2. **File format: one `.sql` per query.** A header of `-- bks:title: ...` and optional `-- bks:database: ...` lines, then a blank line, then the query text. Files without a header are accepted on pull, taking the title from the file name, so plain SQL repositories can be imported. The file name is the title with characters illegal on common filesystems replaced by `_`; collisions get a ` (2)` suffix. The resolved path is checked to stay inside the sync folder.
3. **Identity is the title.** There is no stable id column and a migration is avoided. A renamed query therefore appears as a new query plus an untouched old one. This is accepted and documented.
4. **Three-way change detection with a stored base.** For each title, `L` is the hash of the local query, `R` the hash of the repository file and `B` the hash at the last sync (kept in `git-sync-state.json` in the user directory, keyed by repository path). A pure function classifies the pair into: same, to-local (`L == B`, `R != B`), to-repo (`R == B`, `L != B`), new-in-repo, new-local, or conflict (both changed, or both exist differently with no base). Both pull and push use it, so neither overwrites a side that changed.
5. **Pull = fetch, `pull --ff-only`, apply.** If the branch has diverged or the tree is dirty, git's message is shown and nothing is imported. Then to-local and new-in-repo items are applied and conflicts are returned to the UI.
6. **Push = fetch, refuse when behind, write files, commit, push.** If the branch is behind, the user must pull first. Only the sync folder is added (`git add -A -- <folder>`). The commit is skipped when nothing is staged. Conflicts are returned instead of being written.
7. **Resolution applies immediately.** "Take repository" updates the local query and the base; "keep local" writes the file (committed on the next push) and sets the base; "keep both" saves the repository version as a new query titled `<title> (repo)` and then keeps local for the original.
8. **Auto fetch is client-driven.** `GitSyncBar` calls `gitSync/status` with `fetch: true` on mount and every N minutes while enabled, then shows ahead/behind. Fetch never changes the working tree or the local queries. Failures show as a muted warning, not a dialog.
9. **Settings** `gitSync.repoPath`, `gitSync.subdir`, `gitSync.autoFetch` and `gitSync.interval` (minutes, default 5, minimum 1) use `UserSetting` through `appdb/setting/*`, so they persist.

## Risks / Trade-offs

- [Title as identity breaks on rename] → Documented; rename shows up as a new file and the old file stays until removed by hand.
- [A dirty working tree blocks the fast-forward] → Git's own error is shown unmodified.
- [Large repositories make periodic fetch slow] → Interval is configurable and auto fetch can be turned off.
- [Hashing normalizes line endings and trailing newline, so editor differences do not show as changes] → Intended; text is compared after `\r\n` becomes `\n` and trailing whitespace at the end is trimmed.

## UI note

The Saved Queries heading keeps no git or refresh icons. A bar under it always shows: the branch with ahead/behind counts, one update button (fetch when git is set up, and always reload the saved queries) and the git settings button, then Pull and Push once a repository is set. Before setup the bar reads "Git sync off" and offers only update and settings.

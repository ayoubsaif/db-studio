## 1. Engine

- [x] 1.1 `src/lib/gitSync/format.ts`: render and parse query files, safe file names, content hash; verify with unit tests (header, no header, CRLF, collisions, traversal)
- [x] 1.2 `src/lib/gitSync/classify.ts`: three-way classification; verify with unit tests for every case
- [x] 1.3 `src/lib/gitSync/git.ts`: run git with `execFile`, repository check, branch, ahead/behind, fetch, ff-only pull, add, commit, push; verify against a temporary repository with a bare remote
- [x] 1.4 `src/lib/gitSync/state.ts` and `sync.ts`: base-hash store, pull, push and resolve; verify with integration tests on a temporary repository pair (new, update, conflict, behind, diverged, nothing to commit)

## 2. Handlers

- [x] 2.1 `src/handlers/gitSyncHandlers.ts`: `gitSync/config/get`, `gitSync/config/set`, `gitSync/status`, `gitSync/pull`, `gitSync/push`, `gitSync/resolve`; register in `utility.ts`

## 3. UI

- [x] 3.1 `GitSyncModal.vue`: repository path (folder picker), sub-folder, auto-fetch switch and interval; verify validation message for a non-repository
- [x] 3.2 `GitSyncBar.vue` in `FavoriteList.vue`: ahead/behind, Fetch, Pull, Push, settings button, auto-fetch timer; verify the bar is hidden until configured
- [x] 3.3 Conflict list with keep local, take repository, keep both; verify each choice

## 4. Verify

- [x] 4.1 Run the unit and integration tests, and type check the new files
- [x] 4.2 Build, launch the app against a real clone, and check pull, push, conflict and auto fetch end to end

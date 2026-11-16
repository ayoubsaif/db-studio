## Why

Saved queries live only in the app's local database, so they cannot be shared with a team, versioned or backed up. Teams already keep SQL in git. Importing the queries from a git repository and syncing them back needs to be possible without leaving the app. The existing "Import from local workspace" entry is a paid-edition stub and does nothing here.

## What Changes

- Add a git sync for saved queries that works on a **local repository path**. The user picks a folder that is already a git clone; the app uses the system `git` command, so existing SSH keys and credential helpers keep working.
- Store each saved query as one `.sql` file in the repository (optionally inside a sub-folder), with a small header carrying the title and database.
- Add **Pull** (fetch, fast-forward, import new and changed queries) and **Push** (export changed queries, commit, push) buttons to the Saved Queries sidebar.
- Add **auto fetch**: the app runs `git fetch` when it starts and at a chosen interval, and shows how many commits the local branch is ahead of or behind its upstream.
- When a query changed both in the app and in the repository, stop and let the user choose per query: keep local, take repository, or keep both.
- Add a settings dialog for the repository path, sub-folder and auto-fetch interval.

## Capabilities

### New Capabilities
- `git-query-sync`: importing and syncing saved queries with a local git repository through pull, push and periodic fetch.

### Modified Capabilities
<!-- none -->

## Impact

- **New**: `src/lib/gitSync/` (git runner, file format, change classification, sync engine), `src/handlers/gitSyncHandlers.ts`, `GitSyncBar.vue` and `GitSyncModal.vue` under `src/components/sidebar/core/`.
- **Touched**: `src/utility.ts` and `src/handlers/handlers.ts` (register handlers), `FavoriteList.vue` (mount the bar).
- **Data**: repository settings are stored as user settings; per-query sync state (the last synced content hash) is stored in a JSON file in the user data directory. No database migration.
- **Dependencies**: none. Requires `git` on the PATH.
- **Out of scope**: deleting queries on either side, query folders, merging inside one query's text, cloning a repository from a URL, background push, Windows path quirks beyond using `path`.

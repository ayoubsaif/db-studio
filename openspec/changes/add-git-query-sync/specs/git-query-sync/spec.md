## ADDED Requirements

### Requirement: Configure a local repository
The app SHALL let the user choose a local folder that is a git repository, an optional sub-folder inside it, and an auto-fetch interval.

#### Scenario: Not a repository
- **WHEN** the user saves a path that is not inside a git working tree
- **THEN** the app reports that the path is not a git repository and does not save it

### Requirement: Queries are stored as SQL files
Each saved query SHALL be written to the repository as one `.sql` file whose header holds the title and, when set, the database, followed by the query text.

#### Scenario: Export a query
- **WHEN** a query titled `Monthly sales` is pushed
- **THEN** a file `Monthly sales.sql` exists in the sync folder with a `-- bks:title: Monthly sales` header and the query text

#### Scenario: Import a plain SQL file
- **WHEN** the repository contains `report.sql` with no header
- **THEN** pull creates a saved query titled `report` with the file's text

### Requirement: Pull imports repository changes
Pull SHALL fetch, fast-forward the current branch, and import queries that are new or changed in the repository without overwriting local changes.

#### Scenario: Repository query changed, local unchanged
- **WHEN** a query changed in the repository since the last sync and not locally
- **THEN** pull updates the local query

#### Scenario: Branch diverged
- **WHEN** the local branch cannot be fast-forwarded
- **THEN** pull shows git's error and imports nothing

### Requirement: Push exports local changes
Push SHALL write new and changed local queries to the repository, commit them, and push the branch.

#### Scenario: Behind upstream
- **WHEN** the branch is behind its upstream
- **THEN** push is refused with a message to pull first and nothing is written

#### Scenario: Nothing changed
- **WHEN** no query differs from the repository
- **THEN** push makes no commit

### Requirement: Conflicts are decided per query
When a query changed on both sides since the last sync, the app SHALL stop for that query and offer: keep local, take repository, or keep both. Nothing SHALL be overwritten before the user chooses.

#### Scenario: Keep both
- **WHEN** the user chooses keep both
- **THEN** the repository version is saved as a new local query titled `<title> (repo)` and the local query is kept

### Requirement: Deletions are not propagated
Removing a query on one side SHALL NOT remove it on the other.

#### Scenario: File removed in repository
- **WHEN** a synced file no longer exists in the repository
- **THEN** pull leaves the local query unchanged

### Requirement: Auto fetch
When enabled, the app SHALL run `git fetch` at start and at the configured interval and show how many commits the branch is ahead and behind, without changing queries or the working tree.

#### Scenario: Upstream has new commits
- **WHEN** auto fetch finds commits on the upstream
- **THEN** the sidebar shows the behind count and the Pull button is highlighted

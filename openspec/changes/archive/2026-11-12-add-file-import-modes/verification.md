# Verification: add-file-import-modes

Recorded 2026-11-11 on branch `gpl-community`, with no license key.

Servers: SQLite (file), Postgres 16, MySQL 8.0, SQL Server 2022 (Docker in WSL) and ClickHouse 26.8 (WSL).

How the scenarios were run:
- **Data scenarios:** run through the import engine in `tests/integration/lib/import/import.spec.ts`, once against each database.
- **UI scenarios:** run in the built app with Playwright (`imp.js`, `imp2.js` in the session scratchpad), against Postgres and ClickHouse.
- **Conversion and mode-support rules:** covered by the unit tests in `tests/unit/lib/import/`.

## Results by spec scenario

| Scenario | SQLite | Postgres | MySQL | SQL Server | ClickHouse | How |
|---|---|---|---|---|---|---|
| Open the wizard without an upgrade dialog | | pass | | | pass | app |
| Choose a worksheet (Jan/Feb, pick Feb) | | pass | | | | app + unit |
| No header row: Column 1, Column 2, first row imported | | pass | | | | app + unit |
| Unreadable file: message shown, can't continue | | pass | | | | app + unit |
| Auto mapping `Id`→`id`, `email`→`email`, `Extra` skipped | pass | pass | | | | handler test + app |
| Required column unmapped: warning before running | | pass | | | | app + unit |
| Table without primary key: Update asks for a key | | pass | | | | app + unit |
| Append/Update (keys 1, 2 vs 2, 3): 1 updated, 1 inserted, row 1 unchanged | pass | pass | pass | pass | pass | engine + app (Postgres, ClickHouse) |
| Append without update: row 2 keeps "old", 1 inserted, 1 skipped | pass | pass | pass | pass | pass | engine |
| Delete keys 1 and 5: 1 deleted, 1 skipped | pass | pass | pass | pass | pass | engine |
| Copy needs confirmation naming the table and its row count | | pass | | | | app |
| Duplicate key in the file: last row applied, 1 duplicate reported | pass | pass | pass | pass | pass | engine |
| Decimal comma `12,5` → 12.5 | pass | | | | pass | unit + app (ClickHouse `20,75`) |
| Invalid number `abc`: row fails with column and value | pass | pass | | | | unit + app |
| Preview shows converted values and highlights errors | | pass | | | pass | app |
| Roll back on error: row 501 fails, nothing stays, error names row 501 | pass | pass | pass | pass | n/a (no transactions) | engine |
| Continue on error: rows 10 and 20 listed, the rest imported | pass | pass | pass | pass | pass | engine + app |
| Database without transactions: no-rollback warning | | | | | pass | app + unit |
| Cassandra: Update and Append without update disabled, with reason | | | | | | unit only (see below) |
| Cancel inside a transaction: rolled back, summary says cancelled | pass | pass | pass | pass | n/a | engine + app (Postgres, 400k-row file) |
| Summary with counts and time; copy failed rows | | pass | | | | app |
| Text outside ASCII (`Ñandú 東京 ü€`) round trip | pass | pass | pass | pass | pass | engine |
| Native upsert gives the same table and counts as the generic path | | pass | | | | engine |

## Not verified

- **Cassandra:** this build can't connect to it (it's a paid-only connection type), and no server was available. The disabled modes are covered only by the unit test of the mode support table.
- **UI scenarios on MySQL, SQL Server and SQLite:** these run the same wizard code. Their data paths are verified by the engine tests above.

## Large files

Run with `tests/integration/lib/import/large.spec.ts` (`IMPORT_TEST_LARGE=1`, Electron with `--expose-gc`), Append mode into SQLite, batches of 1,000 in one transaction. Memory is measured after a forced garbage collection, at a quarter of the file and at 95%.

| File | Rows imported | Time | Heap held at 25% | Heap held at 95% | Peak RSS |
|---|---|---|---|---|---|
| CSV | 1,000,000 of 1,000,000 | 143 s | 326 MB | 313 MB | 1,067 MB |
| XLSX | 200,000 of 200,000 | 28 s | 333 MB | 332 MB | 1,057 MB |

Memory doesn't grow with file size. The high baseline comes from Jest running inside Electron, not from the import.

## Checks (task 6.3)

- Unit tests (87) and integration tests (import engine on 5 databases, handlers, large files) pass.
- No file under `src-commercial` was changed, and the import code doesn't reference it.
- Lint doesn't run on this branch: ESLint can't find the config `@vue/typescript`. This happened before this change.

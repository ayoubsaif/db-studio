## Context

The v4.6.2 base has no import engine: `beginImport` in `CoreTabs.vue` just opens the upgrade modal. Export already runs through `src/handlers/exportHandlers.ts` with a streaming pipeline (`src/lib/export/export.ts`), which is the pattern to follow for long-running work with progress. `papaparse` and `xlsx@0.17` are already dependencies. Clients expose `getPrimaryKeys`, `listTableColumns`, `executeQuery`, `applyChanges` and `wrapIdentifier`, and knex builders exist for most dialects.

## Goals / Non-Goals

**Goals:**
- Import files larger than memory: read, convert and write in streaming batches.
- One mode engine that works on every database through a generic path, with optional native fast paths.
- Clear results: exact counts and per-row errors with the file's row numbers.

**Non-Goals:**
- Creating tables from a file, schema inference, saved import profiles, scheduled imports.
- Formats beyond CSV/TSV and `.xlsx` (`.xls` only if `exceljs` reads it, which it does not; `.xls` users must re-save as `.xlsx`).

## Decisions

1. **Readers: `papaparse` for CSV, `exceljs` streaming `WorkbookReader` for `.xlsx`.** Both yield rows one at a time, so memory stays flat. We don't use the existing `xlsx@0.17`: the npm release has known vulnerabilities (prototype pollution and ReDoS) when parsing untrusted files, and fixed releases are only published on the SheetJS CDN. `exceljs` is MIT and on npm. Other uses of `xlsx` in the app are left alone in this change.
2. **Pipeline:** `reader → mapper → converter → batcher → writer`. The mapper applies the column mapping. The converter turns cells into JS values per the target column type (numbers with the chosen decimal separator, dates with the chosen format, booleans, empty to NULL) and records per-row conversion errors. The batcher groups rows (default 500). The writer applies the mode.
3. **Generic mode writer, native fast paths optional.** For every mode except Append and Copy, a batch is processed by first running `SELECT <keys> FROM t WHERE (<keys>) IN (...)` to find which rows already exist, then:

   | Mode | Existing key | New key |
   |---|---|---|
   | Append | insert | insert |
   | Update | `UPDATE ... WHERE keys` | skip |
   | Append/Update | `UPDATE ... WHERE keys` | insert |
   | Append without update | skip | insert |
   | Delete | `DELETE ... WHERE keys` | skip |
   | Copy | (table emptied first) insert | insert |

   This works on any SQL database and gives exact counts. A client may add a fast path for upsert and insert-ignore (`ON CONFLICT`, `ON DUPLICATE KEY UPDATE`, `INSERT IGNORE`, `MERGE`) with an optional method on `BasicDatabaseClient`. The engine uses it only when the chosen keys match a unique constraint. Alternative: native statements only. Rejected, because they need a unique index on the key and don't report updated vs inserted counts on all databases.
4. **Keys.** Default to the table's primary key. The user can pick any mapped columns instead. Update, Append/Update, Append without update and Delete require at least one key, and the wizard blocks Next until one is chosen. Rows whose key appears twice in the same file: the last one wins for Update/Append/Update and the summary counts the duplicates.
5. **Transactions.** When the database supports transactions and the option is on (default), the whole import runs in one transaction on a dedicated connection, and errors in stop mode roll everything back. In continue mode, each batch runs in a savepoint where supported, so one bad row only fails its batch; the batch is then retried row by row to find the exact failing rows. Databases without transactions (ClickHouse, BigQuery, Cassandra) show "changes are applied as they go and can't be rolled back" before running.
6. **Copy mode.** Uses `TRUNCATE` when the database allows it inside the import's transaction; otherwise `DELETE FROM t`. The wizard asks for explicit confirmation showing the table name and current row count.
7. **Mode support per database.** ClickHouse: Append, Copy and Delete (lightweight `DELETE`) supported; Update and Append/Update use `ALTER TABLE ... UPDATE` mutations with `mutations_sync = 1` and a warning. Cassandra: an `INSERT` is always an upsert, so Append, Append/Update and Delete are offered, and Update and Append without update are disabled with an explanation. BigQuery: all modes through DML, with DML quota warnings. Every other SQL database supports all six modes.
8. **Process.** The import runs where database connections live, through a new import handler beside `exportHandlers.ts`, with progress events (rows read, rows written, errors) and cancellation. Cancelling rolls back if in a transaction, or stops after the current batch otherwise.
9. **UI.** A new import tab with four steps: File (pick file, sheet, parse options), Mapping (columns, keys), Mode and options, Preview and run. Port the GPL screens from `master` where they fit v4.6.2 (Vue 2), and add the mode step and key picker ourselves.

## Risks / Trade-offs

- [The key-lookup `IN (...)` query with composite keys isn't supported everywhere (e.g. SQL Server row-value `IN`)] → Build it as `OR` of `AND` groups for databases without tuple `IN`, generated per dialect.
- [Large batches can exceed parameter limits (SQL Server 2100, SQLite 999/32766)] → Cap the batch size per database at `floor(limit / mapped columns)`.
- [Excel stores dates as serial numbers and loses time zones] → Treat Excel date cells as local time and show converted values in the preview so the user can check them before running.
- [The generic path is slower than native upsert on big files] → Acceptable for v1; native fast paths can be added per client later without changing behavior or specs.

## Open Questions

- Default batch size per database may need tuning after testing with real files; this doesn't affect behavior.

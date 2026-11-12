## 1. Setup

- [x] 1.1 Add `exceljs` to `apps/studio/package.json` and verify it loads in the process where database connections run
- [x] 1.2 Create `src/lib/import/` with module skeletons (readers, converter, batcher, writer, engine, types) and verify the app still builds

## 2. Readers and conversion

- [x] 2.1 Implement the CSV reader on `papaparse` streaming (delimiter, quote, encoding, header row, first/last row) and verify unit tests with quoted fields, CRLF, BOM and a non-UTF-8 file
- [x] 2.2 Implement the `.xlsx` reader on `exceljs` `WorkbookReader` (list sheets, pick sheet, header row, first/last row, dates and formula results) and verify unit tests with fixture workbooks
- [x] 2.3 Implement the value converter (numbers with decimal separator, dates with format, booleans, empty to NULL, per-row errors) and verify unit tests per column type
- [x] 2.4 Implement the batcher with per-database maximum batch size from parameter limits, and verify unit tests for SQL Server and SQLite limits

## 3. Mode engine

- [x] 3.1 Implement the key lookup query per dialect (tuple `IN` or `OR` of `AND` groups) and verify unit tests for single and composite keys
- [x] 3.2 Implement the writer for Append, Update, Append/Update, Append without update, Delete and Copy with exact counts and duplicate-key handling, and verify unit tests using an in-memory SQLite table
- [x] 3.3 Implement transactions (whole import on a dedicated connection), stop-on-error rollback, and continue mode with savepoints and row-by-row retry of a failed batch; verify integration tests on Postgres and MySQL
- [x] 3.4 Add the per-database mode support table (ClickHouse mutations, Cassandra limits, BigQuery DML, no-transaction warning) and verify unit tests that each database reports the right enabled modes
- [x] 3.5 Add the optional native upsert/insert-ignore hook on `BasicDatabaseClient`, used only when keys match a unique constraint; verify results are identical with and without it on Postgres

## 4. Handler

- [x] 4.1 Add the import handler beside `src/handlers/exportHandlers.ts` with start, progress events, cancel and summary, and verify an integration test runs a CSV import end to end
- [x] 4.2 Verify cancelling rolls back a transactional import and stops after the current batch otherwise

## 5. UI

- [x] 5.1 Remove the upgrade gate: drop `ultimate: true` on the import menu item in `TableListContextMenus.ts`, make `beginImport` in `CoreTabs.vue` open an import tab, rename the item to "Import from File"; verify with no license key that the tab opens
- [x] 5.2 Build the File step (file picker, sheet picker, parse options, live sample), porting GPL screens from `master` where they fit; verify with CSV and XLSX fixtures
- [x] 5.3 Build the Mapping step (auto map, change, skip, key picker, required-column warnings); verify the auto-mapping and required-key scenarios from the spec
- [ ] 5.4 Build the Mode and options step (six modes with descriptions, disabled modes with reasons, transaction, batch size, error mode, empty as NULL, Copy confirmation with row count); verify on Postgres, Cassandra and ClickHouse
- [x] 5.5 Build the Preview and run step with progress, cancel and the summary (counts, time, copyable failed rows); verify each spec scenario manually in the running app

## 6. Verification

- [x] 6.1 Run every scenario in `specs/table-data-import/spec.md` against Postgres, MySQL, SQL Server and SQLite (and ClickHouse once that change is merged) and record results
- [x] 6.2 Import a 1,000,000-row CSV and a 200,000-row XLSX and confirm memory stays flat and the import completes
- [ ] 6.3 Run lint and unit/integration tests, and confirm no file under any `src-commercial` path was added or used

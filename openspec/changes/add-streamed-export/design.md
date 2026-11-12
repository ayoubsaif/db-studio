## Context

`src/lib/export/export.ts` already streams: an `Export` base class pulls chunks from a client cursor (`selectTopStream` / `queryStream`, `options.chunkSize`) and writes formatted rows to a file through format subclasses (`csv`, `json`, `jsonline`, `sql`). `exportHandlers.ts` runs exports with progress and abort. The query editor already emits `AppEvent.beginExport` with `{ query, queryName }` after its community check. So "Run to File" works once the gate is removed. The remaining work is the Excel format and multi-table export.

## Goals / Non-Goals

**Goals:**
- Full query results and tables of any size exported with flat memory use.
- Multi-table export reusing the single-table pipeline, with no new export engine.

**Non-Goals:**
- Exporting multiple tables into one Excel workbook with one sheet each. One file per table keeps memory and failure handling simple; it can be added later.
- Schema-only exports (DDL dumps) and native backup tools.
- Compressed (zip/gzip) output.

## Decisions

1. **Gates removed, not hidden behind a flag.** Delete the `$config.isCommunity` checks and `stars` icons on the export paths listed in the proposal, rather than flipping `isCommunity`. Other gates in the app (filters, dry run, paid database types) stay as they are; they are out of scope.
2. **Excel via `exceljs` `stream.xlsx.WorkbookWriter`.** It writes rows as they arrive and commits each row, so memory stays bounded. The `Export` base class assumes text output (`getHeader`, `formatRow`, `rowSeparator`, `getFooter` strings written to a file stream). The xlsx exporter overrides the write step to hand rows to the workbook writer and finalize the zip at the end, instead of returning strings. Alternative: CSV with an `.xlsx` extension. Rejected, since Excel then misreads types and warns on open.
3. **Excel types and limits.** Numbers stay numbers, dates become Excel dates, booleans become booleans, and binary or JSON become text. Text longer than Excel's 32,767-character cell limit is cut, and the export summary counts cut cells. When a sheet reaches 1,048,576 rows including the header, the writer starts a new sheet named `<table> (2)` with the header repeated.
4. **Multi-table export = a queue of single-table exports.** The user picks tables in a checklist (grouped by schema, with select-all per schema), a folder, a format and its options. The manager runs one export per table one after another, naming files `<schema>.<table>.<ext>` (or `<table>.<ext>` when there is no schema). If a file exists, the user chooses up front: overwrite, skip, or add a number. A failed table is recorded and the queue continues. The final summary lists rows per table and any failures.
5. **Entry points.** The "Export multiple tables" button in `ExportModal.vue` opens the multi-table dialog with the current table pre-checked. A new "Export tables..." item on the schema/database context menu opens it with all tables in that schema checked.

## Risks / Trade-offs

- [Excel files are much slower to write than CSV and get large] → Show an estimate note in the Excel form ("for millions of rows, CSV is faster") and keep the streaming path.
- [Long multi-table runs hold a connection for a long time] → Each table uses its own cursor, closed after the table finishes; cancelling stops the current table and skips the rest.
- [Database cursors differ in how they stream (some fetch everything)] → Unchanged behavior from today's single-table export; any client that buffers is a separate fix in that client.

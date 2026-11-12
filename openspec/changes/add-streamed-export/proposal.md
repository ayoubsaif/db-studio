## Why

Exporting on this fork is limited for community users. Running a query straight to a file and downloading a full result set open an upgrade dialog, so query results can only be saved as the rows already loaded in the grid. Exporting several tables at once is also gated, and file export has no Excel format. We want export with no row cap and no subscription gate.

## What Changes

- Remove the upgrade gates on "Run to File", "Run Current to File" and "Download Full Resultset" in the query editor (`TabQueryEditor.vue`, `QueryEditorStatusBar.vue`), so the full result streams to a file.
- Add multi-table export: pick several tables (or a whole schema/database), then export them in one job to one file per table in a chosen folder, with an overall progress view. This replaces the gated "Export multiple tables" button in `ExportModal.vue`.
- Add Excel (`.xlsx`) as a file export format, written with a streaming writer so large exports don't run out of memory. Rows beyond Excel's 1,048,576-row sheet limit continue on a new sheet.
- Keep every export streamed from the database in chunks, with no row limit other than disk space (and the Excel per-sheet limit, handled above).
- Remove the paid badge icons (`stars`) on these menu items.

## Capabilities

### New Capabilities
- `data-export`: exporting tables, filtered tables, query results and multiple tables to CSV, JSON, JSON Lines, SQL and Excel files, streamed and without row limits or license checks.

### Modified Capabilities
<!-- none: openspec/specs/ is empty -->

## Impact

- **Touched**: `src/components/TabQueryEditor.vue`, `src/components/editor/QueryEditorStatusBar.vue`, `src/components/export/ExportModal.vue`, `ExportManager.vue`, `src/lib/export/formats/` (new `xlsx.ts`), `src/lib/export/models.ts`, `src/handlers/exportHandlers.ts`, export form components.
- **New UI**: a table picker for multi-table export, and an Excel options form.
- **Dependencies**: `exceljs` (MIT) streaming `WorkbookWriter`; shared with `add-file-import-modes`.
- **Licensing**: only GPL files are changed; nothing from any `src-commercial` directory.
- **Out of scope**: other paid gates in this version (Dry Run, more than two table filters, Oracle/Firebird/Cassandra/LibSQL types, SQL Server Azure auth). Each can be its own change if wanted.

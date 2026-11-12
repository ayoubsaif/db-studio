## 1. Remove export gates

- [x] 1.1 Remove the `$config.isCommunity` early returns and `stars` icons in `submitQueryToFile` / `submitCurrentQueryToFile` and their menu items in `TabQueryEditor.vue`; verify with no license key that "Run to File" opens the export dialog
- [x] 1.2 Remove the `stars` icon on "Download Full Resultset" in `QueryEditorStatusBar.vue`; verify a truncated result downloads every row returned by the query
- [ ] 1.3 Verify with a 10M-row table export to CSV that the output has every row and the app's memory stays flat

## 2. Excel format

- [x] 2.1 Add `exceljs` (if not already added by `add-file-import-modes`) and verify it loads where exports run
- [x] 2.2 Implement `src/lib/export/formats/xlsx.ts` on `stream.xlsx.WorkbookWriter`, overriding the base write step, with typed cells, sheet rollover with repeated header and cell-length cutting counted in the summary; verify unit tests for types, rollover (with a lowered test limit) and cutting
- [x] 2.3 Register the format and add an Excel options form (sheet name, include header) in `src/components/export/forms/`; verify exporting a table and a query to `.xlsx` opens correctly in Excel or LibreOffice

## 3. Multi-table export

- [x] 3.1 Add a multi-table export dialog with a table checklist grouped by schema, select-all per schema, folder picker, format and options, and existing-file choice (overwrite/skip/number); verify it opens from `ExportModal.vue`'s "Export multiple tables" button with the current table checked
- [ ] 3.2 Add "Export tables..." to the schema/database context menu, opening the dialog with that schema's tables checked; verify on Postgres (schemas) and MySQL (databases)
- [x] 3.3 Implement the export queue in `ExportManager.vue` / `exportHandlers.ts`, running tables one after another with file naming, continue-on-failure and a final per-table summary; verify a run where one table fails
- [ ] 3.4 Show progress (current table, tables done/total, rows written) and implement cancel that stops the current table and skips the rest; verify the cancel scenario from the spec

## 4. Verification

- [ ] 4.1 Run every scenario in `specs/data-export/spec.md` manually with no license key and record results
- [ ] 4.2 Run lint and unit tests, and confirm no file under any `src-commercial` path was added or used

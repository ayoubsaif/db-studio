## Why

On this fork, "Import from CSV" only opens an upgrade dialog. The real import lived in the paid edition, and its newer upstream backend is under the commercial license. Users need to load Excel and CSV files into tables the way Navicat does: not just adding rows, but updating, merging and deleting rows matched by a key.

## What Changes

- Add an import wizard on any table (sidebar and table context menus) that reads CSV and Excel (`.xlsx`) files, with sheet selection, header row, first/last data row, delimiter/quote/encoding for CSV, and date and number formats.
- Map file columns to table columns (auto-matched by name, editable), skip columns, and pick key columns.
- Offer six import modes:
  - **Append**: insert every row.
  - **Update**: update matching rows, skip the rest.
  - **Append/Update**: update matching rows, insert new ones.
  - **Append without update**: insert new rows, leave matching rows unchanged.
  - **Delete**: delete matching rows.
  - **Copy**: empty the table, then insert every row.
- Show a preview of the first rows as they'll be written, before running.
- Options: run in one transaction (where supported), batch size, stop on first error or continue and collect errors, treat empty values as NULL.
- Report progress, then a summary with inserted / updated / deleted / skipped / failed counts and the failing row numbers with their errors.
- Works for every supported database, including ClickHouse once `add-clickhouse-community-client` lands, with modes the database can't support disabled and explained.
- Remove the upgrade gate on "Import from CSV" (`ultimate: true` in `TableListContextMenus.ts`, `beginImport` in `CoreTabs.vue`) and rename the menu item to "Import from File".

## Capabilities

### New Capabilities
- `table-data-import`: importing CSV and Excel files into an existing table with column mapping, key matching and the six import modes.

### Modified Capabilities
<!-- none: openspec/specs/ is empty -->

## Impact

- **New code**: an import engine (file readers, row conversion, per-mode writer) in `src/lib/import/`, an import handler next to `src/handlers/exportHandlers.ts`, an import tab and wizard components.
- **Touched**: `src/mixins/TableListContextMenus.ts`, `src/components/CoreTabs.vue`, `src/common/AppEvent.ts`, tab types, and `BasicDatabaseClient` (optional per-database fast paths for upsert and insert-ignore).
- **Dependencies**: `exceljs` (MIT) for streaming `.xlsx` reading; the existing `papaparse` for CSV.
- **Reuse**: the GPL import screens on upstream `master` (`src/components/importtable/*`, `TabImportTable.vue`, `ImportStoreModule.ts`) may be ported as a UI starting point. Nothing from any `src-commercial` directory.
- **Out of scope**: creating a new table from a file, JSON/XML/Access/DBF formats, saved import profiles. These can be later changes.

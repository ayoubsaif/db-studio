## Purpose

Lets every user save tables, filtered tables and full query results to files in common formats, streamed from the database with no row cap and no license or subscription check.

## ADDED Requirements

### Requirement: No subscription gate on export
The system SHALL let every user, with or without a license key, export tables, filtered tables, full query results and multiple tables. No export action SHALL open an upgrade dialog or show a paid-feature badge.

#### Scenario: Run query to file without license
- **WHEN** a user without a license key chooses "Run to File" in the query editor
- **THEN** the export dialog opens for that query instead of an upgrade dialog

#### Scenario: No paid badges
- **WHEN** the user opens the query editor's run menu and the results download menu
- **THEN** no paid-feature icon is shown on any export item

### Requirement: Export without row limits
The system SHALL stream exports from the database in chunks and SHALL write every row of the table or query result, regardless of how many rows are loaded in the grid. Memory use SHALL NOT grow with the number of rows exported.

#### Scenario: Full result set
- **WHEN** a query result shows the first 50,000 rows as truncated and the user chooses "Download Full Resultset"
- **THEN** the file contains every row the query returns, not only the 50,000 shown

#### Scenario: Large table
- **WHEN** the user exports a table with 10 million rows to CSV
- **THEN** the file contains 10 million data rows plus the header, and the export completes without running out of memory

### Requirement: Export formats
The system SHALL export to CSV, JSON, JSON Lines, SQL `INSERT` statements and Excel (`.xlsx`).

#### Scenario: Excel types
- **WHEN** the user exports a table with integer, decimal, date and boolean columns to Excel
- **THEN** opening the file in Excel shows numbers as numbers, dates as dates and booleans as TRUE/FALSE

#### Scenario: Excel sheet limit
- **WHEN** an Excel export has more rows than fit on one sheet
- **THEN** the remaining rows continue on additional sheets, each with the header row repeated

#### Scenario: Long text in Excel
- **WHEN** a cell value is longer than Excel's cell limit
- **THEN** the value is cut to the limit and the export summary reports how many cells were cut

### Requirement: Multi-table export
The system SHALL let the user pick several tables, or all tables in a schema or database, and export them in one run to one file per table in a chosen folder, using one format and set of options. Before running, the user SHALL choose what happens when a file already exists: overwrite, skip, or add a number to the name.

#### Scenario: Export a schema
- **WHEN** the user chooses "Export tables..." on schema `public` with 12 tables, picks CSV and a folder, and runs it
- **THEN** 12 CSV files named after the tables are written to the folder

#### Scenario: One table fails
- **WHEN** one of the selected tables fails to export
- **THEN** the other tables still export, and the summary lists the failed table with its error

#### Scenario: Existing files skipped
- **WHEN** the user chose "skip" and two of the target files already exist
- **THEN** those two tables are not exported and the summary lists them as skipped

### Requirement: Progress and cancel
The system SHALL show progress for each export (rows written, and for multi-table exports the current table and tables done out of total), and SHALL let the user cancel. On cancel or error, the existing "delete file on abort/error" option SHALL apply to the file being written.

#### Scenario: Cancel multi-table export
- **WHEN** the user cancels during table 3 of 5
- **THEN** tables 1 and 2 remain exported, table 3 stops, tables 4 and 5 are not started, and the summary says it was cancelled

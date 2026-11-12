## Purpose

Lets users load CSV and Excel files into an existing table, matching rows by key columns to append, update, merge, skip or delete data in one step, with a preview before anything is written and an exact summary afterwards.

## ADDED Requirements

### Requirement: Start an import from a table
The system SHALL offer "Import from File" in the table's sidebar context menu and the table view, for every database type that supports writing data, without any license check or upgrade prompt.

#### Scenario: Open the wizard
- **WHEN** a user without a license key chooses "Import from File" on a table
- **THEN** an import tab opens for that table and no upgrade dialog appears

### Requirement: Read CSV and Excel files
The system SHALL read `.csv`/`.tsv`/`.txt` and `.xlsx` files. For CSV it SHALL allow choosing delimiter, quote character and encoding. For Excel it SHALL allow choosing the worksheet. For both it SHALL allow choosing the header row (or no header), the first data row and an optional last data row. Files larger than available memory SHALL import without loading the whole file at once.

#### Scenario: Choose a worksheet
- **WHEN** the user selects an `.xlsx` file with sheets "Jan" and "Feb" and picks "Feb"
- **THEN** the column list and preview come from the "Feb" sheet

#### Scenario: No header row
- **WHEN** the user turns off "First row is header"
- **THEN** columns are named "Column 1", "Column 2" and so on, and the first row is imported as data

#### Scenario: Unreadable file
- **WHEN** the user selects a corrupt or password-protected file
- **THEN** the wizard shows that the file can't be read and does not continue

### Requirement: Column mapping
The system SHALL map file columns to table columns automatically by case-insensitive name, and SHALL let the user change any mapping or skip a file column. A table column that is not nullable and has no default SHALL be flagged if it is left unmapped in modes that insert rows.

#### Scenario: Auto mapping
- **WHEN** the file has columns `Id`, `email`, `Extra` and the table has `id`, `email`
- **THEN** `Id` maps to `id`, `email` maps to `email`, and `Extra` is set to skip

#### Scenario: Required column unmapped
- **WHEN** a NOT NULL column without default is unmapped and the mode is Append
- **THEN** the wizard warns about the column before running

### Requirement: Key columns
The system SHALL use the table's primary key as the default key and SHALL let the user choose any mapped columns as the key instead. The Update, Append/Update, Append without update and Delete modes SHALL require at least one key column.

#### Scenario: Table without primary key
- **WHEN** the table has no primary key and the user chooses Update
- **THEN** the wizard asks the user to choose key columns before continuing

### Requirement: Import modes
The system SHALL support these modes, matching file rows to table rows by the key columns:
- Append: insert every file row.
- Update: update table rows whose key matches a file row; skip file rows without a match.
- Append/Update: update matching rows and insert the rest.
- Append without update: insert file rows without a match; leave matching table rows unchanged.
- Delete: delete table rows whose key matches a file row.
- Copy: remove all existing rows from the table, then insert every file row.

Rows in the table that don't appear in the file SHALL stay unchanged in every mode except Copy.

#### Scenario: Append/Update
- **WHEN** the table has keys 1 and 2, the file has keys 2 and 3, and the mode is Append/Update
- **THEN** row 2 is updated, row 3 is inserted, row 1 is unchanged, and the summary shows 1 updated and 1 inserted

#### Scenario: Append without update
- **WHEN** the table has key 2 with name "old", the file has key 2 with name "new" and key 3, and the mode is Append without update
- **THEN** row 2 keeps name "old", row 3 is inserted, and the summary shows 1 inserted and 1 skipped

#### Scenario: Delete
- **WHEN** the file lists keys 1 and 5 and only key 1 exists in the table
- **THEN** row 1 is deleted and the summary shows 1 deleted and 1 skipped

#### Scenario: Copy needs confirmation
- **WHEN** the user runs Copy on a table with 1,000 rows
- **THEN** the app asks for confirmation naming the table and its 1,000 rows before deleting anything

#### Scenario: Duplicate keys in the file
- **WHEN** the file contains key 7 twice and the mode is Update
- **THEN** the last of the two rows is the one applied and the summary reports one duplicate key

### Requirement: Value conversion
The system SHALL convert file values to the target column type using the chosen date format and decimal separator, and SHALL optionally treat empty values as NULL (on by default). A value that can't be converted SHALL be an error for that row, not a silent change.

#### Scenario: Decimal comma
- **WHEN** the decimal separator is set to comma and a cell contains `12,5`
- **THEN** the value written to a numeric column is 12.5

#### Scenario: Invalid number
- **WHEN** a cell contains `abc` for an integer column
- **THEN** that row is reported as failed with the column name and value

### Requirement: Preview before running
The system SHALL show the first rows as they will be written, after mapping and conversion, along with which mode, key and options will be used, before any data is changed.

#### Scenario: Preview shows converted values
- **WHEN** the user reaches the preview step
- **THEN** dates and numbers are shown as they will be stored, and conversion errors in the previewed rows are highlighted

### Requirement: Error handling and transactions
The system SHALL offer "stop on first error" (default) and "continue and collect errors". When the database supports transactions and "use a transaction" is on (default), stopping on an error SHALL leave the table exactly as it was before the import. For databases without transactions, the wizard SHALL warn before running that changes are applied as they go and can't be rolled back.

#### Scenario: Roll back on error
- **WHEN** row 501 violates a constraint on a Postgres table with stop-on-error and transactions on
- **THEN** no rows from the file remain in the table and the error names file row 501

#### Scenario: Continue on error
- **WHEN** rows 10 and 20 fail and "continue and collect errors" is on
- **THEN** all other rows are imported and the summary lists rows 10 and 20 with their errors

#### Scenario: Database without transactions
- **WHEN** the target is a ClickHouse table
- **THEN** the wizard shows the no-rollback warning before running

### Requirement: Modes a database can't support
The system SHALL disable import modes the target database can't perform and explain why next to the disabled option.

#### Scenario: Cassandra
- **WHEN** the target is a Cassandra table
- **THEN** Update and Append without update are disabled with an explanation that Cassandra inserts always overwrite

### Requirement: Progress, cancel and summary
The system SHALL show progress while importing (rows processed), SHALL allow cancelling, and SHALL show a summary at the end with counts of inserted, updated, deleted, skipped and failed rows and the time taken.

#### Scenario: Cancel inside a transaction
- **WHEN** the user cancels a transactional import halfway
- **THEN** the import stops, the changes are rolled back, and the summary says it was cancelled

#### Scenario: Summary
- **WHEN** an import finishes
- **THEN** the summary shows each count, and the user can copy the list of failed rows with their errors

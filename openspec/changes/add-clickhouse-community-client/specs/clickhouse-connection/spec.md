## Purpose

Lets every user connect to a ClickHouse server, browse its objects, run queries and edit data within the limits ClickHouse itself sets, with no license or subscription check.

## ADDED Requirements

### Requirement: ClickHouse connection type
The system SHALL offer ClickHouse as a connection type with fields for host, port, user, password, default database and TLS on/off. The default port SHALL be 8123 without TLS and 8443 with TLS.

#### Scenario: Successful connection
- **WHEN** the user enters valid ClickHouse credentials and clicks Connect
- **THEN** the app connects and shows the database's tables in the sidebar

#### Scenario: Wrong credentials
- **WHEN** the user enters a wrong password and clicks Connect
- **THEN** the app shows the authentication error returned by the server and stays on the connection screen

#### Scenario: Test connection
- **WHEN** the user clicks Test with valid credentials
- **THEN** the app reports success and shows the server version

### Requirement: No subscription gate for ClickHouse
The system SHALL NOT require a license, show an upgrade prompt, or mark ClickHouse as a paid feature anywhere in the app.

#### Scenario: Community user connects
- **WHEN** a user without any license key creates, saves and opens a ClickHouse connection
- **THEN** no upgrade dialog or paid-feature badge is shown at any step

### Requirement: Browse databases and objects
The system SHALL list user databases, and within the selected database its tables, views and materialized views, each with their columns. System databases SHALL be hidden by default.

#### Scenario: Switch database
- **WHEN** the user picks another database from the database switcher
- **THEN** the sidebar lists that database's tables, views and materialized views

#### Scenario: Column details
- **WHEN** the user expands a table in the sidebar
- **THEN** the columns are listed with their ClickHouse types, and primary key columns are marked

### Requirement: Table data view
The system SHALL show table data with paging, sorting and filters, and SHALL show the table's total row count.

#### Scenario: Paging large table
- **WHEN** the user opens a table with more rows than one page
- **THEN** the first page is shown and the user can move to the next page

#### Scenario: Filter
- **WHEN** the user adds a filter `id > 100`
- **THEN** only rows matching the filter are shown

### Requirement: Query execution
The system SHALL run SQL from the query editor, show the results of each statement, allow cancelling a running query, and support streaming results to a file without a row limit.

#### Scenario: Run a query
- **WHEN** the user runs `SELECT number FROM system.numbers LIMIT 10`
- **THEN** ten rows are shown with column `number`

#### Scenario: Cancel a query
- **WHEN** the user cancels a long-running query
- **THEN** the query stops on the server and the editor shows it was cancelled

#### Scenario: Syntax error
- **WHEN** the user runs invalid SQL
- **THEN** the error message from ClickHouse is shown and no results are displayed

### Requirement: Table structure and properties
The system SHALL show a table's columns, primary and sorting keys, engine, size on disk and row count, and SHALL provide the table's `CREATE` statement.

#### Scenario: View create script
- **WHEN** the user chooses "SQL: Create" on a table
- **THEN** a query tab opens containing the table's `CREATE TABLE` statement as reported by the server

### Requirement: Data editing within ClickHouse limits
The system SHALL allow inserting rows, and updating and deleting rows using all primary key columns to identify them. Before saving updates or deletes, the system SHALL warn that the changes run as mutations, may affect every row with the same key, and cannot be rolled back. The save SHALL complete only after the server finishes the changes.

#### Scenario: Insert a row
- **WHEN** the user adds a row in the data grid and saves
- **THEN** the row is inserted and appears after the grid refreshes

#### Scenario: Update with confirmation
- **WHEN** the user edits a cell and saves
- **THEN** the app asks for confirmation explaining the mutation warning, and after confirming the grid shows the new value

#### Scenario: Partial failure
- **WHEN** the second of three pending changes fails on the server
- **THEN** the app shows the error and says which changes were applied, since earlier ones cannot be undone

### Requirement: Unsupported features are hidden
The system SHALL hide or disable features ClickHouse doesn't support, including routines, triggers, charset/collation selection, partitions editing and backup/restore, instead of showing errors.

#### Scenario: Create database
- **WHEN** the user creates a new database from the app
- **THEN** only a name is asked for, with no charset or collation fields

## ADDED Requirements

### Requirement: Package installs on current Arch
The Arch package SHALL declare only dependencies that exist in the current Arch repositories.

#### Scenario: Install without dependency errors
- **WHEN** the package is installed with `pacman -U`
- **THEN** dependency resolution succeeds

### Requirement: Separate identity and data
The packaged app SHALL use its own package name, install directory and user data directory, distinct from the official Beekeeper Studio.

#### Scenario: Coexists with an official install
- **GIVEN** an official Beekeeper Studio install and data directory
- **WHEN** the fork is installed and started
- **THEN** it uses `~/.config/db-studio` and does not read or write the official data directory

### Requirement: Packaged UI and database load
The packaged app SHALL load its renderer assets and open its application database.

#### Scenario: First start
- **WHEN** the packaged app starts with no existing data directory
- **THEN** the loading screen ends, the interface is styled, and the database is created with all migrations applied

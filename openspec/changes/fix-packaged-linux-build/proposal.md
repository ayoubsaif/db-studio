## Why

The fork was packaged for Arch Linux and would not start: it stayed on the "Loading" screen. Investigation found four independent faults in the old base, none related to the user's data:

- The renderer built with Vite `base: '/'`, so the packaged `index.html` requested `/assets/*`, but the `app://` handler serves `dist/` and the files sit in `dist/renderer/assets/`. The UI bundle never loaded.
- `background.ts` passed `isPackage` to the utility process while `platform_info.ts` read `isPackaged`, so the utility process always believed it was a dev build and opened an empty `app-dev.db`, giving `no such table: saved_connection`.
- electron-builder's default pacman dependency list includes `http-parser`, which Arch no longer ships, so `pacman -U` refused the package.
- The package reused the identity `beekeeper-studio` and the data directory `~/.config/beekeeper-studio`, colliding with an official install.

Porting onto upstream 6.2.2 was considered and rejected: since 2024-08-21 upstream's entry points, handlers and plugin system live in `src-commercial/`, which is under a commercial license and cannot be used here. The fork stays on its GPL-only base.

## What Changes

- Give the packaged app its own identity: product name "DB Studio", app id `dev.ayoubsaif.dbstudio`, executable and package name `db-studio`, data directory `~/.config/db-studio`.
- Set Vite `base: './'` so assets resolve beside `renderer/index.html`.
- Pass `isPackaged` to the utility process and read it as the string `'true'`.
- Point the Linux launcher script at `db-studio-bin`.
- Override the pacman dependency list with packages that exist in current Arch repositories.

## Capabilities

### New Capabilities
- `linux-packaging`: the Arch package installs next to an official install and starts with working UI and database.

### Modified Capabilities
<!-- none -->

## Impact

- **Touched**: `apps/studio/electron-builder-config.js`, `apps/studio/vite.config.mjs`, `apps/studio/src/background.ts`, `apps/studio/src/common/platform_info.ts`, `apps/studio/build/launcher-script.sh`.
- **Users**: the fork's saved connections live in a new directory; nothing is shared with, or migrated from, an official install.
- **Out of scope**: porting to a newer upstream, other platforms (the `deb` dependency list and `deb-postinstall` still say `beekeeper-studio`), tray icon support (`libappindicator-gtk3` is not in the Arch repos).

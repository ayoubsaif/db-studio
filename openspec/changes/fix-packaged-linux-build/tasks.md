## 1. Packaging

- [x] 1.1 Override the pacman dependencies; verify `pacman -Qpi` lists only packages present in the Arch repos
- [x] 1.2 Rename identity (productName, appId, `extraMetadata.name`, executable, WM class); verify the package is `db-studio` and the app creates `~/.config/db-studio`
- [x] 1.3 Point `build/launcher-script.sh` at `db-studio-bin`; verify the launcher starts the app

## 2. Startup fixes

- [x] 2.1 Set Vite `base: './'`; verify `dist/renderer/index.html` uses `./assets/` and the UI is styled
- [x] 2.2 Pass `isPackaged` from `background.ts` and read it in `platform_info.ts`; verify the utility process uses `app.db` and the demo database opens

## 3. Install and verify

- [x] 3.1 Install with `sudo pacman -U apps/studio/dist_electron/db-studio-4.6.2.pacman` and launch `db-studio`
- [x] 3.2 Check the custom features in the installed app: query "Run to File", multi-table export, `.xlsx` export, file import, ClickHouse connection
- [x] 3.3 Commit the changes

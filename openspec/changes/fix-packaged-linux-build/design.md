## Context

The fork is based on upstream from 2024-08-19 (package version 4.6.2), the last upstream state without `src-commercial/`. The Arch package is built with electron-builder's `pacman` target (fpm bundled). The first install attempt failed on dependencies, then the app started but never left the loading screen.

## Goals / Non-Goals

**Goals:**
- `pacman -U` installs cleanly, and the app starts and works on Arch/Wayland.
- No clash with an official Beekeeper Studio install or its data.

**Non-Goals:**
- Tracking newer upstream releases (blocked by the commercial-code split).
- Fixing the `deb`/`snap`/`AppImage` targets.

## Decisions

1. **Rename through electron-builder, not the workspace.** `extraMetadata.name = "db-studio"` changes the packaged app's name (which drives Electron's userData path) without renaming the yarn workspace `beekeeper-studio` that root scripts call. `productName`, `appId`, `linux.executableName` and `StartupWMClass` follow. Alternative: rename `apps/studio/package.json`. Rejected because root scripts and the lockfile reference the workspace name.
2. **Relative Vite base.** `base: './'` makes `index.html` in `dist/renderer/` load `./assets/*` through the `app://` handler. Alternative: teach the handler to fall back to `renderer/`. Rejected as larger and hiding the config error.
3. **Fix the `isPackaged` mismatch at both ends.** Main sends `isPackaged`; `platform_info.ts` treats the utility process (no `electron.app`) as packaged only when the value is the string `'true'`, since env values are strings and `'false'` is truthy.
4. **Explicit pacman deps.** `gtk3 libnotify nss libxss libxtst xdg-utils at-spi2-core util-linux-libs libsecret`, each checked against the repos. `libappindicator-gtk3` dropped (absent); only the tray icon is affected.

## Risks / Trade-offs

- [The renderer still computes `isDevEnv` as true, because the renderer has no `electron.app` and no `isPackaged` env] → unchanged behavior from before; revisit only if a renderer feature depends on it.
- [Users lose nothing but start with an empty profile] → intended; the old profile belongs to the official app.

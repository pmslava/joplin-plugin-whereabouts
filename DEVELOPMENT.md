# Developing Whereabouts

## Requirements

- Node 18+ and npm
- Linux/macOS/Windows for building; the end-to-end suite is written for Linux (it needs `xvfb-run`)
- Joplin desktop **3.7 or newer** to run against

## Build

```bash
npm install          # also runs `npm run dist` via the `prepare` script
npm run dist
```

`npm run dist` produces:

- `dist/` — the unpacked plugin (`index.js`, `contentScripts/titleChip.js`, `manifest.json`,
  `whereabouts.css`)
- `publish/io.github.pmslava.whereabouts.jpl` — the installable plugin archive
- `publish/io.github.pmslava.whereabouts.json` — the plugin-info file used by the Joplin plugin
  repository

`npm run updateVersion` syncs `package.json` and `src/manifest.json` version numbers.

## Installing a local build

**Joplin caches plugin code for the lifetime of the process, so a rebuild is not picked up by a
running Joplin.** Install and then fully quit and relaunch — do not use a window reload.

1. `npm run dist`
2. Joplin → **Tools → Options → Plugins → gear icon → Install from file** →
   `publish/io.github.pmslava.whereabouts.jpl`
3. **Quit Joplin completely** (not just close the window) and start it again.

For a faster loop, point Joplin at `dist/` as a development plugin instead: **Tools → Options →
Plugins → Advanced → Development plugins**, set it to the absolute path of this repo's `dist`
folder, then quit and relaunch after each `npm run dist`.

## How it is put together

| File | Role |
| --- | --- |
| `src/index.ts` | Plugin main process: settings, chrome CSS, content-script registration, the state builder (notebook path + guards), and the three click actions. |
| `src/contentScripts/titleChip.ts` | The chip itself. Runs in the renderer, injects into Joplin's note title bar, and posts actions back. |
| `src/common.ts` | Types and constants shared by both bundles. Must not import `joplin` or CodeMirror. |
| `src/whereabouts.css` | Chip styling (all `--joplin-*` theme variables) plus the native-pill hide rule. |

Three things in the source look odd and are deliberate. Each is commented in place; read the comment
before changing them:

1. **The chip is delivered by a CodeMirror content script even though it never touches the note
   body.** There is no plugin API that reaches Joplin's title bar. A `CodeMirrorPlugin` content
   script is loaded as a plain `<script>` in the renderer document, which is the only way to get
   plugin JavaScript into that DOM. It cannot be replaced with a panel.
2. **Everything is derived from `view.dom.ownerDocument`, never the global `document`.** Joplin
   appends the content script to the *main* window even when the editor is in a secondary window, so
   the global `document` is the wrong one there.
3. **Only three insertion slots are used** (direct child of `.note-title-wrapper`, direct child of
   `.editor-toolbar`, or the immediate next sibling of `.note-title-wrapper`), the insert is
   idempotent, and a `MutationObserver` repairs it. React re-renders the title bar on every note
   switch and at the 800px width breakpoint; without this the chip vanishes.

## End-to-end tests

The suite launches the **real Joplin desktop app** with this plugin loaded against a throwaway
profile, and drives it with Playwright over CDP. It asserts against genuine Joplin DOM, which is the
only way to catch a break in the private selectors this plugin depends on.

```bash
npm run test:e2e
```

That wraps: `npm run dist` → `npm run setup:e2e` → `xvfb-run playwright test`.

### Supplying the Joplin build

`scripts/setup-e2e.sh` extracts a Joplin AppImage into `.e2e-cache/squashfs-root/`.

```bash
# Use an AppImage already on disk (no download):
JOPLIN_E2E_APPIMAGE=~/.joplin/Joplin.AppImage npm run setup:e2e

# Or download a specific version (default 3.7.14):
JOPLIN_E2E_VERSION=3.7.14 npm run setup:e2e
```

It is idempotent — once `.e2e-cache/squashfs-root/joplin` exists it does nothing.

### Test data

Notebooks and notes are seeded through **Joplin's own Data API** (`e2e/dataApi.ts`), not through the
GUI: the suite needs a *nested* notebook, and the desktop app's only route to a sub-notebook is a
native Electron context menu that Playwright cannot drive.

Each throwaway profile gets a random `api.token`, and port discovery accepts a port only if that
token authenticates there — so a developer's own running Joplin (which has a different token and
answers 403) is skipped rather than written to.

Seeded fixture: `Alpha` → `Alpha/Beta`, plus a sibling `Gamma`; one note in `Beta`, one in `Gamma`.

### The machine-wide lock

`e2e/guard.ts` takes a single lock under `~/.cache/joplin-plugin-e2e.lock`, **shared with the
sibling plugin repos** (Cockpit, Ridgeline). Only one E2E run may be live on a machine at a time; a
second run queues rather than stacking a second Joplin. It also sweeps orphaned Joplin/Xvfb
processes left by dead runs — scoped strictly to *this repo's* `.e2e-cache/squashfs-root` path, so
it can never touch a Joplin you are actually using.

Do not bypass the lock.

### Suite layout

| Spec | Launches Joplin with | Covers |
| --- | --- | --- |
| `e2e/chip.spec.ts` | defaults | chip renders in the native pill slot; updates on note switch; survives viewer-only layout; hides the native pill; left click filters and keeps the note |
| `e2e/path-mode.spec.ts` | `pathMode: 'full'` | `Alpha / Beta` for a nested notebook |
| `e2e/placement.spec.ts` | `placement: 'inline-right'`, then `'toolbar-first'` | both non-default containers |
| `e2e/native-pill.spec.ts` | `hideNativePill: false` | the native pill stays visible |

Each `test.describe` that needs a different startup configuration launches its own Joplin, because
plugin settings are read from the profile at startup and there is no reliable GUI route to change
them mid-run.

Run one spec while iterating:

```bash
npm run dist
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test e2e/chip.spec.ts --reporter=list
```

Failures leave a trace and screenshot under `test-results/`; `playwright-report/` has the HTML
report.

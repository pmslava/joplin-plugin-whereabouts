# Changelog

All notable changes to Whereabouts are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [0.3.0] — Unreleased

Part A of the secondary-window rework. Part B does not change what the Cockpit calls do — they
already fire on every path, from either window — it adds the end-to-end coverage for them: a
throwaway profile with Cockpit 2.4.0 installed alongside Whereabouts, asserting that a left click
filters Cockpit's panel to the notebook and a double click reveals the note there, plus whatever
Cockpit's reveal turns out to need from this side.

### Changed

- **Left click and double click now work in a secondary editor window** (Note → Open in new
  window). They were the two actions still disabled there in 0.2.1, because they are navigation:
  Joplin keeps one redux store whose ROOT state is the FOCUSED window's (the `WINDOW_FOCUS` reducer
  swaps window slices in and out of root), every command reads and writes that one store, and a
  plugin cannot pass a window id — so `openNote` called from a detached editor would have
  rearranged that window instead of the main one.

  Whereabouts now hands focus to the main window first and runs the action there, so a click on a
  secondary window's chip brings the main window forward and takes it to the notebook (and, on a
  double click, reveals the note in the note list) while the secondary window stays on the note you
  were reading. The switch is borrowed from core's `focusElementSideBar`, which calls
  `bridge().switchToMainWindow()`; when the sidebar is hidden that command does nothing at all, so
  the fallback is `focusElementNoteList`, which carries the same switch. `focusElementNoteList` is
  not the first choice because it also focuses and marks the note-list row, which is exactly what
  separates a single click from a double click here.

  **The hand-off is proved, not assumed, and not with a sleep.** The plugin pings the focused
  window's editor with a one-off id and waits for that id to come back from an editor that says it
  is in the MAIN window. Joplin routes `editor.execCommand` by focus — an editor whose document does
  not have focus scores zero and cannot win the call — so an echo from the main window's editor is a
  direct observation that the main window has focus, and therefore that its slice is the root state.
  The id matters: every editor also polls on its own schedule, so a reply that merely arrives after
  a ping proves nothing. The plugin re-pings across a 2.5s budget, because the first ping can
  legitimately still reach the old window and because a main window that was minimised needs a
  moment after being raised. If it is never confirmed, both windows are left untouched and the
  console says which of the three causes it was: the switch command threw, the main window has no
  Markdown editor to act in, or it never took focus. After the navigation the plugin checks once
  that it landed — root state on the note AND the main window's editor holding it — and logs
  precisely if not, rather than re-issuing anything.

  Focus afterwards: a single click leaves the main window's note body focused, exactly as a single
  click in the main window does, so the "single click does not steal focus" rule holds across
  windows; a double click leaves the note list focused with the row marked, which is the whole
  point of a double click.

  Overlapping gestures are dropped while an action is in flight — the hand-off is no longer
  instantaneous, so a second click during one would otherwise start a second, racing hand-off. A
  double click still supersedes a single click that has not been sent yet.

  Right-click to move is unchanged from 0.2.1: it stays in the window you clicked in, where its
  picker belongs. The chip in a secondary window is now an ordinary live chip — the "-move-only"
  tooltip and menu cursor are gone, and its tooltip is the same as everywhere else. It carries a
  `data-secondary` attribute so which-window-am-I can be asserted from outside.

  All the existing guards still apply everywhere: conflict notes, notes in the trash and notes in a
  read-only share stay fully inert.

### Fixed

- **The chip's text is back to the size it was in 0.1.0.** It inherits the title area's text size
  again (13px on the default theme, against the date label's 12px and the toolbar buttons' 14.4px)
  instead of the `0.9 × base` — 10.8px — that 0.2.0 introduced while replacing a CSS variable that
  turns out not to exist. The editor-toolbar placement is unaffected: there the chip is a core
  toolbar button and core sizes it.


## [0.2.1] — 2026-09-03

### Changed

- **Right-click to move now works in a secondary editor window** (Note → Open in new window). It was
  disabled there along with the other two actions, which was over-cautious: `moveToFolder` moves by
  explicit note id and touches no selection, and a secondary window mounts its own dialogs — so the
  picker opens in the window you right-clicked in and files the note that window is showing. Filing
  a note you have opened in its own window is exactly when you want to.

  The click actions stay disabled there, because they are navigation: selecting a notebook and
  revealing a note act on the sidebar and note list in the main window. The chip now says which is
  which — its tooltip reads "Right-click to move · click actions work in the main window" and its
  cursor shows a menu rather than a link, instead of the chip looking uniformly dead.

  The existing guards are unchanged: conflict notes, notes in the trash and notes in a read-only
  share stay fully inert everywhere.


## [0.2.0] — 2026-09-03

Placements rework, after 0.1.0 was used on a real profile.

### Added

- **`below-title-compact` placement.** The chip gets its own row below the title, and the title
  row's date label and note-toolbar icons move down onto that row, right-aligned — so the note
  title itself gets the full width. Nothing is re-parented: the layout is CSS keyed off a marker
  class the content script puts on `.note-title-wrapper`, because moving React's own nodes would
  crash the editor on its next reconcile.
- Screenshots for all four placements, captured from the running app by the end-to-end suite and
  referenced from the manifest and the README, so they cannot drift from what the plugin renders.

### Changed

- **`toolbar-first` is replaced by `editor-toolbar`.** The chip now goes at the head of the EDITOR
  toolbar (the formatting-button row, `#CodeMirrorToolbar`) instead of the note toolbar at the top
  right of the title row, which was the wrong place for it. A stored `toolbar-first` is migrated to
  `editor-toolbar` automatically.
- Placement labels are clearer: "Own row below the title", "Own row below the title, title-row icons
  moved down", "Right of the title", "First item of the editor toolbar".

### Fixed

- **The notebook name is now always visible.** In 0.1.0 the note-toolbar placement rendered
  icon-only on a real profile: core's `.toolbar-button` clamps itself to a square and hides its
  overflow, so the label was squeezed to zero width with no ellipsis to show anything was missing.
  The chip now refuses to shrink or be clamped in every placement. `showIcon` toggles the glyph
  only; the name has no setting and is never hidden.
- **Spacing around the chip's row.** The blank space above the chip now equals the blank space
  below it, and both match the gap a normal single-line title leaves before the editor toolbar
  (13px on the shipped theme) — so the chip reads as one more line of the editor rather than a
  banner with more air on one side. This is measured in *ink*: Joplin's title input extends about
  12px below the last inked pixel of the title, so balancing the boxes still looked lopsided on
  screen. The depth used is the title font's own descender depth, measured once per font, so the
  chip never shifts while a title is being typed. In the compact placement the moved icons are also brought to the chip's own height, so
  they cannot set the gap below it.
- **`below-title` left edge.** The chip now lands exactly on the title text and the editor toolbar.
  As well as asking for Joplin's editor padding (with a fallback, since that CSS variable only
  exists while the theme defines it), the chip measures the toolbar at runtime and corrects itself
  — a custom theme or user stylesheet can otherwise leave the variable disagreeing with the value
  core actually used for the editor column.


## 0.1.0 — 2026-09-03

First working version. Not yet published to the Joplin plugin repository.

### Added

- A notebook chip in the note title area, shown on **every** note in **every** view — not only in
  search, tag and "All notes" views, where Joplin shows its own **In: \<Notebook\>** button.
- **What to show**: the notebook name only (`Beta`), or the full path from the root
  (`Alpha / Beta`), with a configurable separator.
- **Where to show it**: on its own row below the title (the slot Joplin's own pill uses), inline to
  the right of the title, or as the first item of the note toolbar.
- **Hide Joplin's own "In: \<Notebook\>" button**, on by default, so the two do not duplicate each
  other.
- **Show the notebook icon**, on by default.
- Click actions on the chip: left click selects the notebook in the sidebar while keeping the note
  open (Joplin's `FOLDER_AND_NOTE_SELECT`, exactly what the native pill does), double click reveals
  the note in the note list, right click opens the "Move to notebook" picker.
- Optional [Cockpit](https://github.com/pmslava/joplin-plugin-cockpit) integration: a left click also
  filters its panel to the notebook and a double click reveals the note there. Both are
  fire-and-forget, so Whereabouts behaves identically without Cockpit installed.
- All settings apply live — no restart.
- End-to-end suite driving the real Joplin 3.7.14 desktop app over CDP: rendering and placement,
  the three click actions, two editor windows each naming their own notebook, and the chip keeping
  up with a note being moved and a notebook being renamed while the app runs.

### Notes and limitations

- Desktop only; the Markdown editor (including Split and Viewer-only layouts). The Rich Text editor
  has no CodeMirror instance, so no plugin code runs there and no chip appears.
- The chip is injected into Joplin's internal title-bar DOM, which has no plugin API. Selectors are
  verified against Joplin 3.7.x and `app_min_version` is pinned to `3.7`.
- Each editor reports its own notebook, including a secondary editor window: the editor tells the
  plugin which note it holds (via CodeMirror's noteId facet) rather than the plugin guessing from
  the selected note, which follows window focus.
- In a secondary editor window, and for conflict notes, notes in the trash and notes in a read-only
  share, the chip shows the location but its click actions are disabled.
- Disabling the plugin leaves the chip in place until Joplin is restarted: there is no unload hook
  for a mounted editor extension and no API to drop a loaded chrome stylesheet.
- `revealInNotebook` (core PR laurent22/joplin#16354) is feature-detected: once it ships, double
  click uses it; until then it falls back to `openNote` + `focusElementNoteList`.
- A notebook RENAME raises no plugin event, so each editor re-asks for its state on a timer. The
  cost is held down by memoised notebook paths, skipping the check while the window is hidden, and
  backing the interval off to 5s once the answer stops changing.
- Failed actions are reported to the console with a `[whereabouts]` prefix rather than silently
  doing nothing.

[0.3.0]: https://github.com/pmslava/joplin-plugin-whereabouts/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/pmslava/joplin-plugin-whereabouts/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pmslava/joplin-plugin-whereabouts/releases/tag/v0.2.0

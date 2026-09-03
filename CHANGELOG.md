# Changelog

All notable changes to Whereabouts are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/pmslava/joplin-plugin-whereabouts/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pmslava/joplin-plugin-whereabouts/releases/tag/v0.2.0

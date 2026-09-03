# Changelog

All notable changes to Whereabouts are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-09-03

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

[Unreleased]: https://github.com/pmslava/joplin-plugin-whereabouts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pmslava/joplin-plugin-whereabouts/releases/tag/v0.1.0

// Types and constants shared between the plugin main process (src/index.ts) and the CodeMirror
// content script (src/contentScripts/titleChip.ts). Keep this module free of any `joplin` or
// CodeMirror import: it is bundled into BOTH builds.

export const PLUGIN_ID = 'io.github.pmslava.whereabouts';

/** Content-script id used by contentScripts.register / onMessage. */
export const CONTENT_SCRIPT_ID = 'whereabouts-title-chip';

/**
 * Command the content script self-registers so the plugin can tell the editor "something changed,
 * ask me again", via `joplin.commands.execute('editor.execCommand', { name })`.
 *
 * It is a PING, not a state push. The plugin process cannot know which note a given editor holds —
 * `joplin.workspace.selectedNote()` reads the root redux state, and Joplin's WINDOW_FOCUS reducer
 * swaps the focused window's state into root, so it answers for whichever window has focus. Only
 * the editor itself knows its own note (from `noteIdFacet`), so the editor must be the one to ask.
 */
export const REFRESH_COMMAND = 'whereabouts.refresh';

/**
 * Class the content script sets on its own document's <html> when `hideNativePill` is on. The
 * hide rule in whereabouts.css is scoped under it, so the setting is live and per-document (the
 * chrome CSS file is linked into every Joplin window, including secondary editor windows).
 */
export const HIDE_NATIVE_CLASS = 'whereabouts-hide-native';

/** Marker attribute on the injected chip, so re-inserting is idempotent. */
export const CHIP_ATTRIBUTE = 'data-whereabouts-chip';

export const SETTING_PATH_MODE = 'pathMode';
export const SETTING_PLACEMENT = 'placement';
export const SETTING_HIDE_NATIVE_PILL = 'hideNativePill';
export const SETTING_SEPARATOR = 'separator';
export const SETTING_SHOW_ICON = 'showIcon';

export type PathMode = 'last' | 'full';
export type Placement = 'inline-right' | 'below-title' | 'toolbar-first';

export interface WhereaboutsSettings {
	pathMode: PathMode;
	placement: Placement;
	hideNativePill: boolean;
	separator: string;
	showIcon: boolean;
}

export const DEFAULT_SETTINGS: WhereaboutsSettings = {
	pathMode: 'last',
	// Matches the slot Joplin's own "In: <Notebook>" pill uses, so the chip looks native.
	placement: 'below-title',
	hideNativePill: true,
	separator: ' / ',
	showIcon: true,
};

/** Everything the content script needs to render the chip and decide whether clicks may act. */
export interface ChipState {
	settings: WhereaboutsSettings;
	/** '' when no note is open — the chip is then removed. */
	noteId: string;
	/** '' for a conflict note (no real parent) — the chip is then removed. */
	folderId: string;
	/** Notebook titles root-first, e.g. ['Lab', 'Joplin']. Empty means "nothing to show". */
	path: string[];
	/**
	 * False when acting on the note would be wrong or would fail: a conflict note (it lives in the
	 * "Conflicts" notebook, which the chip happily names, but filtering/moving out of it is not
	 * meaningful), a note in the trash, or a note in a read-only share. The chip still shows the
	 * location; only the clicks go inert.
	 */
	actionable: boolean;
}

export type ChipAction = 'filter' | 'reveal' | 'move';

export type ContentScriptMessage =
	// `noteId` is the id THIS editor holds, taken from the CodeMirror noteId facet. It is what makes
	// a secondary editor window show its own notebook instead of the focused window's. It is omitted
	// only when the facet is unavailable, in which case the plugin falls back to the selected note.
	| { type: 'getState'; noteId?: string }
	| { type: 'action'; action: ChipAction; noteId: string; folderId: string };

/** What the plugin answers an `action` message with, so the content script can report a failure. */
export interface ActionResult {
	ok: boolean;
	error?: string;
}

/** Render the chip's label from a state. Pure, so both sides agree and it is trivially testable. */
export function chipLabel(state: ChipState): string {
	const { path, settings } = state;
	if (!path.length) return '';
	if (settings.pathMode === 'full') return path.join(settings.separator);
	return path[path.length - 1];
}

/** Defensive coercion: a seeded or hand-edited settings.json can carry anything. */
export function coerceSettings(raw: Partial<WhereaboutsSettings> | null | undefined): WhereaboutsSettings {
	const pathMode: PathMode = raw?.pathMode === 'full' ? 'full' : 'last';
	const placement: Placement =
		raw?.placement === 'inline-right' || raw?.placement === 'toolbar-first' ? raw.placement : 'below-title';
	// Default true: only an explicit `false` shows the native pill again.
	const hideNativePill = raw?.hideNativePill !== false;
	const separator = typeof raw?.separator === 'string' ? raw.separator : DEFAULT_SETTINGS.separator;
	const showIcon = raw?.showIcon !== false;
	return { pathMode, placement, hideNativePill, separator, showIcon };
}

/** An empty state: no note, nothing to render. Used before the first round-trip answers. */
export function emptyState(settings: WhereaboutsSettings = DEFAULT_SETTINGS): ChipState {
	return { settings, noteId: '', folderId: '', path: [], actionable: false };
}

// Types and constants shared between the plugin main process (src/index.ts) and the CodeMirror
// content script (src/contentScripts/titleChip.ts). Keep this module free of any `joplin` or
// CodeMirror import: it is bundled into BOTH builds.

export const PLUGIN_ID = 'io.github.pmslava.whereabouts';

/** Content-script id used by contentScripts.register / onMessage. */
export const CONTENT_SCRIPT_ID = 'whereabouts-title-chip';

/**
 * Command the content script self-registers so the plugin can push a fresh state into the editor
 * with `joplin.commands.execute('editor.execCommand', { name, args })`.
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
	 * False for conflict notes and notes in the trash: the chip still shows where the note sits,
	 * but filtering/revealing/moving it would be wrong or would fail, so clicks are inert.
	 */
	actionable: boolean;
}

export type ChipAction = 'filter' | 'reveal' | 'move';

export type ContentScriptMessage =
	| { type: 'getState' }
	| { type: 'action'; action: ChipAction; noteId: string; folderId: string };

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

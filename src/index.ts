import joplin from 'api';
import { ContentScriptType, SettingItemType, SettingStorage } from 'api/types';
import {
	CONTENT_SCRIPT_ID,
	PLUGIN_ID,
	REFRESH_COMMAND,
	SETTING_HIDE_NATIVE_PILL,
	SETTING_PATH_MODE,
	SETTING_PLACEMENT,
	SETTING_SEPARATOR,
	SETTING_SHOW_ICON,
	coerceSettings,
	emptyState,
	type ChipState,
	type ContentScriptMessage,
	type WhereaboutsSettings,
} from './common';

const SETTINGS_SECTION = 'whereabouts.settings';

// A corrupted parent_id chain must not loop forever while walking to the root.
const MAX_NOTEBOOK_DEPTH = 100;

// Fields we need to decide whether the chip may act on a note.
const NOTE_FIELDS = ['id', 'parent_id', 'is_conflict', 'deleted_time'];

interface GuardedNote {
	id: string;
	parent_id: string;
	is_conflict: number;
	deleted_time: number;
}

async function registerSettings(): Promise<void> {
	await joplin.settings.registerSection(SETTINGS_SECTION, {
		label: 'Whereabouts',
		iconName: 'fas fa-map-signs',
		description: 'Always show the current note\'s notebook next to its title.',
	});

	await joplin.settings.registerSettings({
		[SETTING_PATH_MODE]: {
			value: 'last',
			type: SettingItemType.String,
			isEnum: true,
			public: true,
			section: SETTINGS_SECTION,
			label: 'What to show',
			description: 'Show only the notebook the note is in, or its whole path from the root.',
			options: { last: 'Notebook name only', full: 'Full path (Parent / Child)' },
			// File storage so the value persists AND can be seeded into a profile's settings.json,
			// which is how the E2E suite starts Joplin in a given configuration.
			storage: SettingStorage.File,
		},
		[SETTING_PLACEMENT]: {
			value: 'below-title',
			type: SettingItemType.String,
			isEnum: true,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Where to show it',
			description:
				'Below the title is the slot Joplin\'s own "In: <Notebook>" pill uses in search results. ' +
				'Applies live.',
			options: {
				'below-title': 'On its own row below the title',
				'inline-right': 'Inline, to the right of the title',
				'toolbar-first': 'As the first item of the note toolbar',
			},
			storage: SettingStorage.File,
		},
		[SETTING_HIDE_NATIVE_PILL]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Hide Joplin\'s own "In: <Notebook>" button',
			description:
				'Joplin shows a blue "In: <Notebook>" button under the title in search, tag and ' +
				'"All notes" views. With Whereabouts always showing the notebook, that button is a ' +
				'duplicate. Applies live.',
			storage: SettingStorage.File,
		},
		[SETTING_SEPARATOR]: {
			value: ' / ',
			type: SettingItemType.String,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Path separator',
			description: 'Placed between notebook names when the full path is shown. Applies live.',
			storage: SettingStorage.File,
		},
		[SETTING_SHOW_ICON]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Show the notebook icon',
			description: 'Show Joplin\'s notebook glyph before the name. Applies live.',
			storage: SettingStorage.File,
		},
	});
}

async function readSettings(): Promise<WhereaboutsSettings> {
	const values = await joplin.settings.values([
		SETTING_PATH_MODE,
		SETTING_PLACEMENT,
		SETTING_HIDE_NATIVE_PILL,
		SETTING_SEPARATOR,
		SETTING_SHOW_ICON,
	]);
	return coerceSettings(values as Partial<WhereaboutsSettings>);
}

/**
 * Walk the parent_id chain to the root and return notebook titles root-first, e.g. ['Lab', 'Joplin'].
 * A missing ancestor stops the walk rather than failing the whole lookup, so a broken chain still
 * yields the deepest part of the path — which is all the default "last name only" mode needs.
 *
 * Same shape as the helper in joplin-plugin-copy-note-id; kept local so the two plugins stay
 * independent.
 */
async function notebookTitlePath(folderId: string): Promise<string[]> {
	const titles: string[] = [];
	let id = folderId;
	for (let hop = 0; hop < MAX_NOTEBOOK_DEPTH && id; hop++) {
		let folder;
		try {
			folder = await joplin.data.get(['folders', id], { fields: ['id', 'title', 'parent_id'] });
		} catch (error) {
			break;
		}
		if (!folder) break;
		titles.unshift(folder.title);
		id = folder.parent_id;
	}
	return titles;
}

/**
 * Re-read the note through the data API rather than trusting whatever the content script passed us.
 * The content script lives in the renderer where any other plugin's code also runs, and the note may
 * have moved or been deleted since the chip was drawn.
 */
async function loadGuardedNote(noteId: string): Promise<GuardedNote | null> {
	if (!noteId) return null;
	try {
		return (await joplin.data.get(['notes', noteId], { fields: NOTE_FIELDS })) as GuardedNote;
	} catch (error) {
		return null;
	}
}

/**
 * A note is "actionable" when filtering to its notebook, revealing it in the list, or moving it are
 * all meaningful. Conflict notes have no real parent notebook, and a note in the trash lives in a
 * pseudo-notebook the sidebar cannot select — acting on either would jump the user somewhere wrong.
 */
function isActionable(note: GuardedNote | null): boolean {
	if (!note) return false;
	if (!note.parent_id) return false;
	if (note.is_conflict) return false;
	if (note.deleted_time) return false;
	return true;
}

/** The state the chip renders: current note, its notebook path, and whether clicks may act. */
async function buildState(): Promise<ChipState> {
	const settings = await readSettings();
	let selected;
	try {
		selected = await joplin.workspace.selectedNote();
	} catch (error) {
		selected = null;
	}
	if (!selected || !selected.id) return emptyState(settings);

	const note = await loadGuardedNote(selected.id);
	const folderId = note?.parent_id ?? '';
	if (!folderId) return { settings, noteId: selected.id, folderId: '', path: [], actionable: false };

	const path = await notebookTitlePath(folderId);
	return { settings, noteId: selected.id, folderId, path, actionable: isActionable(note) };
}

/**
 * Fire a command and swallow every failure. Used for the optional Cockpit integration: those
 * commands do not exist yet, and CommandService throws on an unknown command name. Whereabouts must
 * work identically with and without Cockpit installed.
 */
async function tryExecute(name: string, ...args: unknown[]): Promise<void> {
	try {
		await joplin.commands.execute(name, ...args);
	} catch (error) {
		// Expected whenever the command is not registered. Nothing to report.
	}
}

/**
 * Left click: select the note's notebook in the sidebar WITHOUT losing the open note.
 *
 * `openNote` dispatches FOLDER_AND_NOTE_SELECT — exactly what Joplin's own "In: <Notebook>" pill
 * does. Do NOT "simplify" this to `openFolder`: that clears the note selection and jumps to the
 * folder's last-viewed note, which is not what the user asked for by clicking the location of the
 * note they are reading.
 */
async function doFilter(noteId: string, folderId: string): Promise<void> {
	await joplin.commands.execute('openNote', noteId);
	// Optional: if Cockpit is installed, point its panel at the same notebook. Fire-and-forget.
	await tryExecute('cockpit.filterByNotebook', folderId);
}

/**
 * Double click: reveal the note in the note list.
 *
 * `revealInNotebook` is core PR laurent22/joplin#16354, still unmerged as of 3.7.14 — feature-detect
 * it so this picks up the native behaviour for free once it ships, and falls back to the two-step
 * equivalent until then.
 */
async function doReveal(noteId: string): Promise<void> {
	try {
		await joplin.commands.execute('revealInNotebook', noteId);
	} catch (error) {
		await joplin.commands.execute('openNote', noteId);
		await joplin.commands.execute('focusElementNoteList', noteId);
	}
	await tryExecute('cockpit.revealNote', noteId);
}

/** Right click: Joplin's own "Move to notebook" picker. The argument MUST be an array of ids. */
async function doMove(noteId: string): Promise<void> {
	await joplin.commands.execute('moveToFolder', [noteId]);
}

/**
 * CommandService does NOT enforce a command's enabledCondition for plugin-initiated calls, so every
 * guard has to be applied here. Re-check the note at action time, not at render time.
 */
async function handleAction(message: Extract<ContentScriptMessage, { type: 'action' }>): Promise<void> {
	const note = await loadGuardedNote(message.noteId);
	if (!isActionable(note)) return;
	// Act on the note's CURRENT parent, not the one the chip was drawn with.
	const folderId = note.parent_id;

	switch (message.action) {
		case 'filter':
			await doFilter(note.id, folderId);
			break;
		case 'reveal':
			await doReveal(note.id);
			break;
		case 'move':
			await doMove(note.id);
			break;
		default:
			break;
	}
}

async function onContentScriptMessage(message: ContentScriptMessage): Promise<unknown> {
	if (!message || typeof message !== 'object') return null;
	switch (message.type) {
		case 'getState':
			return buildState();
		case 'action':
			await handleAction(message);
			return { ok: true };
		default:
			return null;
	}
}

/**
 * Push a fresh state into the focused window's editor. `editor.execCommand` only reaches the FOCUSED
 * window's CodeMirror instance and throws when no Markdown editor is focused at all (Rich Text, or
 * the app still starting), so failures here are normal — the content script also polls, which is how
 * unfocused windows keep up.
 */
async function pushRefresh(): Promise<void> {
	let state: ChipState;
	try {
		state = await buildState();
	} catch (error) {
		return;
	}
	try {
		await joplin.commands.execute('editor.execCommand', { name: REFRESH_COMMAND, args: [state] });
	} catch (error) {
		// No focused Markdown editor. The poll in the content script covers it.
	}
}

joplin.plugins.register({
	onStart: async () => {
		await registerSettings();

		// Chrome CSS: styles the chip and carries the (class-scoped) native-pill hide rule. Joplin
		// links this file into EVERY window's document — the main one and secondary editor windows —
		// via StyleSheetContainer, so the chip is styled wherever the editor is.
		const installDir = await joplin.plugins.installationDir();
		await joplin.window.loadChromeCssFile(`${installDir}/whereabouts.css`);

		// The ONLY way plugin JS reaches Joplin's note title bar. A CodeMirrorPlugin content script is
		// loaded as a plain <script> in the renderer document (no sandbox), so it can touch the title
		// DOM directly. There is no official API for this: panels dock beside the sidebar and toolbar
		// buttons are command-driven icons.
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CONTENT_SCRIPT_ID,
			'./contentScripts/titleChip.js',
		);
		await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, onContentScriptMessage);

		// Selecting another note switches which notebook the chip must name.
		await joplin.workspace.onNoteSelectionChange(async () => {
			await pushRefresh();
		});
		// onNoteChange also fires when the open note is MOVED to another notebook — that is the event
		// that keeps the chip honest right after a right-click move.
		await joplin.workspace.onNoteChange(async () => {
			await pushRefresh();
		});
		await joplin.settings.onChange(async () => {
			await pushRefresh();
		});

		console.info(`[whereabouts] ${PLUGIN_ID} started`);
	},
});

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
	type ActionResult,
	type ChipState,
	type ContentScriptMessage,
	type WhereaboutsSettings,
} from './common';

const SETTINGS_SECTION = 'whereabouts.settings';

// A corrupted parent_id chain must not loop forever while walking to the root.
const MAX_NOTEBOOK_DEPTH = 100;

// Fields we need to decide whether the chip may act on a note. `share_id` feeds the read-only-share
// check below.
const NOTE_FIELDS = ['id', 'parent_id', 'is_conflict', 'deleted_time', 'share_id'];

/**
 * How long a resolved notebook path may be reused before it is walked again.
 *
 * Renaming a notebook fires NO plugin event, so the only way the chip can notice one is to re-read.
 * The editors poll for exactly that reason, and this TTL is what keeps the poll from turning into a
 * folder walk per editor per tick: within the window every editor is answered from memory.
 */
const FOLDER_PATH_TTL_MS = 10_000;

// Sync targets that are Joplin Server / Joplin Cloud, the only ones where sharing (and therefore a
// read-only share) exists. Mirrors core's `joplinServerConnected` when-clause.
const SHARING_SYNC_TARGETS = [9, 10, 11];

interface GuardedNote {
	id: string;
	parent_id: string;
	is_conflict: number;
	deleted_time: number;
	share_id: string;
}

/** The shape of the `sync.shareCache` global setting that core's read-only check reads. */
interface ShareCache {
	shares: Array<{ id: string; user?: { id?: string } }>;
	shareInvitations: Array<{ share: { id: string }; can_write: number | boolean }>;
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
async function walkNotebookTitlePath(folderId: string): Promise<string[]> {
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
 * Memoised notebook paths.
 *
 * Every mounted editor polls (see the content script), and a path is a walk of one API call per
 * ancestor, so without this a deep notebook would cost N reads per editor per tick forever. Entries
 * expire after FOLDER_PATH_TTL_MS so a RENAME still shows up on its own — that is the one change no
 * plugin event reports — and `invalidateFolderPaths()` drops them immediately on the events that DO
 * fire (a note changed, a sync landed), so a move or a synced rename is reflected at once.
 */
const folderPathCache = new Map<string, { path: string[]; readAt: number }>();

function invalidateFolderPaths(): void {
	folderPathCache.clear();
}

async function notebookTitlePath(folderId: string): Promise<string[]> {
	const cached = folderPathCache.get(folderId);
	if (cached && Date.now() - cached.readAt < FOLDER_PATH_TTL_MS) return cached.path;
	const path = await walkNotebookTitlePath(folderId);
	folderPathCache.set(folderId, { path, readAt: Date.now() });
	return path;
}

/**
 * Core's `noteIsReadOnlyShare` when-clause, reimplemented from the inputs a plugin can reach.
 *
 * `moveToFolder` declares `enabledCondition: 'someNotesSelected && !noteIsReadOnlyShare'`, but
 * CommandService does NOT evaluate enabledCondition for plugin-initiated calls — so offering "move"
 * on a note shared with us read-only would push the user into a picker whose result the sync layer
 * then rejects. Mirrors `itemIsReadOnlySync` in @joplin/lib/models/utils/readOnly: a note is
 * read-only when it belongs to a share we do not own and our invitation to that share has no write
 * permission. Anything we cannot determine resolves to "writable", so the guard never silently
 * disables the chip on a normal local note.
 */
async function noteIsReadOnlyShare(note: GuardedNote): Promise<boolean> {
	if (!note.share_id) return false;
	try {
		const [syncTarget, userId, rawCache] = await joplin.settings.globalValues([
			'sync.target',
			'sync.userId',
			'sync.shareCache',
		]);
		if (!SHARING_SYNC_TARGETS.includes(Number(syncTarget))) return false;
		if (!userId) return false;
		if (typeof rawCache !== 'string' || !rawCache) return false;

		const cache = JSON.parse(rawCache) as ShareCache;
		const invitations = cache?.shareInvitations ?? [];
		// Core short-circuits the whole check when there are no invitations at all.
		if (!invitations.length) return false;

		const share = (cache?.shares ?? []).find((s) => s.id === note.share_id);
		if (share && share.user && share.user.id === userId) return false; // we own it

		const invitation = invitations.find((i) => i?.share?.id === note.share_id);
		return invitation ? !invitation.can_write : false;
	} catch (error) {
		// A malformed cache or an unavailable setting must not make a normal note un-actionable.
		console.warn('[whereabouts] could not evaluate share permissions; treating as writable', error);
		return false;
	}
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
 * all meaningful. A conflict note does live in a real "Conflicts" notebook — the chip names it
 * happily — but filtering or moving out of it is not what the click means; a note in the trash sits
 * in a pseudo-notebook the sidebar cannot select; and a read-only share would reject the move.
 */
async function isActionable(note: GuardedNote | null): Promise<boolean> {
	if (!note) return false;
	if (!note.parent_id) return false;
	if (note.is_conflict) return false;
	if (note.deleted_time) return false;
	if (await noteIsReadOnlyShare(note)) return false;
	return true;
}

/**
 * The state the chip renders: the note, its notebook path, and whether clicks may act.
 *
 * `noteId` is the note the ASKING EDITOR holds, and it matters. `joplin.workspace.selectedNote()`
 * reads the ROOT redux state, and Joplin's WINDOW_FOCUS reducer swaps the focused window's state
 * into root (app.reducer `handleWindowActions`), so it reports whichever window has focus — not the
 * window that asked. With a secondary editor window open, trusting it would make BOTH chips name the
 * focused window's notebook and make a click on the background chip act on the other window's note.
 * The editor therefore supplies its own id from CodeMirror's noteId facet, and `selectedNote()` is
 * only a fallback for a Joplin that does not expose that facet.
 */
async function buildState(noteId?: string): Promise<ChipState> {
	const settings = await readSettings();

	let id = typeof noteId === 'string' ? noteId : '';
	if (!id) {
		try {
			const selected = await joplin.workspace.selectedNote();
			id = selected?.id ?? '';
		} catch (error) {
			id = '';
		}
	}
	if (!id) return emptyState(settings);

	const note = await loadGuardedNote(id);
	if (!note) return emptyState(settings);

	const folderId = note.parent_id ?? '';
	if (!folderId) return { settings, noteId: id, folderId: '', path: [], actionable: false };

	const path = await notebookTitlePath(folderId);
	return { settings, noteId: id, folderId, path, actionable: await isActionable(note) };
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
 *
 * Failures are RETURNED, never thrown and never swallowed: `openNote` throws when the note or its
 * parent notebook has vanished since the chip was drawn, and `moveToFolder` throws on an id it
 * cannot load. The content script logs what comes back, so a broken action leaves a trace instead
 * of looking like a dead button — and the user never gets a raw Electron error dialog.
 */
async function handleAction(
	message: Extract<ContentScriptMessage, { type: 'action' }>,
): Promise<ActionResult> {
	const note = await loadGuardedNote(message.noteId);
	if (!note) return { ok: false, error: `note ${message.noteId} could not be loaded` };
	if (!(await isActionable(note))) {
		return { ok: false, error: `note ${note.id} is a conflict, trashed, or read-only note` };
	}
	// Act on the note's CURRENT parent, not the one the chip was drawn with.
	const folderId = note.parent_id;

	try {
		switch (message.action) {
			case 'filter':
				await doFilter(note.id, folderId);
				return { ok: true };
			case 'reveal':
				await doReveal(note.id);
				return { ok: true };
			case 'move':
				await doMove(note.id);
				return { ok: true };
			default:
				return { ok: false, error: `unknown action ${String(message.action)}` };
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[whereabouts] action "${message.action}" failed:`, error);
		return { ok: false, error: detail };
	}
}

async function onContentScriptMessage(message: ContentScriptMessage): Promise<unknown> {
	if (!message || typeof message !== 'object') return null;
	switch (message.type) {
		case 'getState':
			return buildState(message.noteId);
		case 'action':
			return handleAction(message);
		default:
			return null;
	}
}

/**
 * Nudge the focused window's editor to ask for its state again.
 *
 * Deliberately a PING with no payload: this process cannot tell which note the receiving editor
 * holds (see buildState), so pushing a state would risk handing a window another window's notebook.
 * `editor.execCommand` reaches only the FOCUSED window's CodeMirror instance and throws when no
 * Markdown editor is focused at all (Rich Text, or the app still starting), so failures here are
 * normal — every editor also polls, which is how unfocused windows keep up.
 */
async function pingRefresh(): Promise<void> {
	try {
		await joplin.commands.execute('editor.execCommand', { name: REFRESH_COMMAND });
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
			await pingRefresh();
		});
		// onNoteChange also fires when the open note is MOVED to another notebook — that is the event
		// that keeps the chip honest right after a right-click move. A move can also mean the note now
		// sits under a different ancestry, so drop the memoised paths with it.
		await joplin.workspace.onNoteChange(async () => {
			invalidateFolderPaths();
			await pingRefresh();
		});
		// A sync can rename or re-parent notebooks under us with no other notification.
		await joplin.workspace.onSyncComplete(async () => {
			invalidateFolderPaths();
			await pingRefresh();
		});
		await joplin.settings.onChange(async () => {
			await pingRefresh();
		});

		console.info(`[whereabouts] ${PLUGIN_ID} started`);
	},
});

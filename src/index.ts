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
				'"Own row below the title" is the slot Joplin\'s own "In: <Notebook>" pill uses in ' +
				'search results. The compact variant moves the title row\'s date and icons down onto ' +
				'the chip\'s row, so the title itself gets the full width. Applies live.',
			options: {
				'below-title': 'Own row below the title',
				'below-title-compact': 'Own row below the title, title-row icons moved down',
				'inline-right': 'Right of the title',
				'editor-toolbar': 'First item of the editor toolbar',
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
 * Fire a command and swallow every failure, deliberately.
 *
 * Two kinds of caller use it, and both want the same thing — the action's OUTCOME must not depend
 * on this call:
 *  - the optional Cockpit integration, whose commands may simply not exist (CommandService throws
 *    on an unknown command name), because Whereabouts must behave identically with and without
 *    Cockpit installed;
 *  - the focus tidy-up after a secondary-window single click (`focusElementNoteBody`), which is a
 *    cosmetic finishing move: the navigation has already happened and succeeded, and failing the
 *    whole action because focus could not be parked would be a worse outcome than the wrong element
 *    holding it.
 *
 * The command that SWITCHES windows is pointedly NOT called through here — see
 * `handOverToMainWindow`: there, a throw is a distinct failure cause that has to be reportable.
 */
async function tryExecute(name: string, ...args: unknown[]): Promise<void> {
	try {
		await joplin.commands.execute(name, ...args);
	} catch (error) {
		// Expected whenever the command is not registered. Nothing to report.
	}
}

// ── handing focus to the main window ────────────────────────────────────────────────────────────

/**
 * The hand-off's time budget, how often it re-pings inside that budget, and how often it looks for
 * an answer.
 *
 * 2.5s is set by the slowest honest case rather than by taste: a main window that was minimised is
 * only raised by the switch, and its editor skips its poll entirely while the document is hidden
 * (see the poll in the content script), so it can need a moment before it is in a position to
 * answer at all. Re-pinging matters for the same reason — the first ping can legitimately still be
 * routed to the secondary window, and a single ping would then be indistinguishable from a failure.
 */
const HANDOFF_TIMEOUT_MS = 2500;
const HANDOFF_PING_MS = 150;
const HANDOFF_POLL_MS = 40;

/** The same, for the after-the-fact check that the action really landed in the main window. */
const VERIFY_TIMEOUT_MS = 1500;

/** Sleep helper for the poll loops below. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The last thing a MAIN-window editor told us, and whether it was answering one of our pings.
 *
 * The plugin process has no window identity of its own and no API that reports one. What it does
 * have is that every editor now says whether it is in a secondary window on each state request, so
 * a request carrying `secondary: false` can only have come from the main window's editor. `nonce`
 * is what makes such a request *evidence* rather than a coincidence: it is set only when the request
 * was triggered by a plugin ping, and carries that ping's id.
 */
interface MainWindowReport {
	noteId: string;
	at: number;
	/** The ping this report answers, or '' when the editor was just running its own poll. */
	nonce: string;
}
let mainWindowReport: MainWindowReport | null = null;

let nonceCounter = 0;
function nextNonce(): string {
	nonceCounter += 1;
	return `${Date.now().toString(36)}-${nonceCounter}`;
}

/**
 * Nudge the FOCUSED window's editor to ask for its state again, optionally tagging the request so
 * the answer can be recognised.
 *
 * Deliberately a PING with no state payload: this process cannot tell which note the receiving
 * editor holds (see buildState), so pushing a state would risk handing a window another window's
 * notebook. `editor.execCommand` reaches only the FOCUSED window's editor and throws when no
 * Markdown editor is focused at all (Rich Text, or the app still starting), so failures here are
 * normal for the event-driven callers — every editor also polls, which is how unfocused windows
 * keep up. `handOverToMainWindow` uses the same one-window routing as a measuring instrument.
 */
async function pingRefresh(nonce?: string): Promise<void> {
	try {
		await joplin.commands.execute(
			'editor.execCommand',
			nonce ? { name: REFRESH_COMMAND, args: [nonce] } : { name: REFRESH_COMMAND },
		);
	} catch (error) {
		// No focused Markdown editor. The poll in the content script covers it.
	}
}

/**
 * Ping until the MAIN window's editor answers one of OUR pings, or the deadline passes.
 *
 * This is the actual focus probe. `editor.execCommand` is registered once per editor and resolved
 * by priority, and the priority is a focus question: app-desktop
 * `gui/NoteEditor/utils/getWindowCommandPriority.ts` scores an editor 0 unless its own document
 * reports `hasFocus()`, so an unfocused window's editor cannot win the call. A reply that both
 * says `secondary: false` and carries the nonce we have just sent therefore means Joplin routed an
 * editor command to the MAIN window — which is the same statement as "the main window has focus",
 * and so, through `WINDOW_FOCUS`, "the main window's slice is the root state". (That last link is
 * `webContents.on('focus')` -> `send('window-focused')` in app-desktop `ElectronAppWrapper.ts`
 * lines 385-391 and 427-429, then the `WINDOW_FOCUS` dispatch in app-desktop `app.ts` lines
 * 739-748, then `handleFocus` swapping the slices.)
 *
 * The nonce is what makes this evidence. Every editor also polls on its own schedule, so a reply
 * from the main window arriving shortly after a ping proves nothing on its own — it may simply be
 * that window's own timer. Only an echo of this call's id does.
 *
 * `wantNoteId`, when given, additionally requires the main window's editor to be holding that note,
 * which is how the after-the-fact check tells that `openNote` landed where it was meant to.
 */
async function awaitMainWindowPingReply(
	deadline: number,
	wantNoteId?: string,
): Promise<MainWindowReport | null> {
	while (Date.now() < deadline) {
		const nonce = nextNonce();
		await pingRefresh(nonce);
		const listenUntil = Math.min(Date.now() + HANDOFF_PING_MS, deadline);
		for (;;) {
			const report = mainWindowReport;
			if (report && report.nonce === nonce && (!wantNoteId || report.noteId === wantNoteId)) {
				return report;
			}
			if (Date.now() >= listenUntil) break;
			await delay(HANDOFF_POLL_MS);
		}
	}
	return null;
}

/** One `LayoutItem` of Joplin's persisted `ui.layout`, as far as this plugin cares. */
interface StoredLayoutItem {
	key?: string;
	visible?: boolean;
	children?: StoredLayoutItem[];
}

function findLayoutItem(item: StoredLayoutItem | null | undefined, key: string): StoredLayoutItem | null {
	if (!item || typeof item !== 'object') return null;
	if (item.key === key) return item;
	for (const child of item.children ?? []) {
		const found = findLayoutItem(child, key);
		if (found) return found;
	}
	return null;
}

/**
 * Is the main window's sidebar on screen?
 *
 * It decides WHICH core command can be borrowed to switch windows, because `focusElementSideBar`
 * silently does nothing when the sidebar is hidden (app-desktop
 * `gui/Sidebar/commands/focusElementSideBar.ts` lines 17-23 wrap the whole body, including
 * `switchToMainWindow()`, in `if (sidebarVisible)`). The plugin cannot read that condition the way
 * the command does — it evaluates `state.mainLayout`, which is app state a plugin has no access to
 * — but it can read the same layout from where MainScreen persists it: `Setting.setValue('ui.layout',
 * saveLayout(mainLayout))` (app-desktop `gui/MainScreen.tsx` line 342), a non-secure global setting,
 * so `settings.globalValue` returns it. `saveLayout` keeps each item's `visible` flag
 * (`gui/ResizableLayout/utils/persist.ts` lines 6-27).
 *
 * Anything unreadable answers "visible", which is both the default layout and the safe assumption:
 * the worst case is that the switch command turns out to be a no-op, and the hand-off then fails
 * loudly instead of quietly doing the wrong thing.
 */
async function sidebarIsVisible(): Promise<boolean> {
	try {
		const layout = (await joplin.settings.globalValue('ui.layout')) as StoredLayoutItem | null;
		const sidebar = findLayoutItem(layout, 'sideBar');
		return sidebar ? sidebar.visible !== false : true;
	} catch (error) {
		return true;
	}
}

/** Why a hand-off did not happen. Kept apart so the warning can say which one it was. */
type HandoffFailure = 'switch-failed' | 'no-main-editor' | 'not-confirmed';

function describeHandoffFailure(failure: HandoffFailure): string {
	switch (failure) {
		case 'switch-failed':
			return 'the command that switches windows threw';
		case 'no-main-editor':
			return 'the main window never reported in, so it has no Markdown editor to act in (no note open there, or the Rich Text editor)';
		default:
			return 'the main window did not take focus in time';
	}
}

/**
 * Hand focus to the MAIN window and prove it happened. Returns null on success, otherwise the
 * reason — and on any failure NOTHING has been navigated.
 *
 * WHY THIS IS NEEDED. Joplin keeps ONE redux store, and the state at its root is the FOCUSED
 * window's: the `WINDOW_FOCUS` reducer swaps the newly focused window's slice into root and the
 * previous one out (`handleWindowActions` / its `handleFocus` in @joplin/lib's reducer). Commands
 * read and write that one store — CommandService's `createContext()` is
 * `{ state: this.store_.getState(), dispatch: t => this.store_.dispatch(t) }` for every runtime,
 * with no per-window store — and `openNote` is a
 * `context.dispatch({ type: 'FOLDER_AND_NOTE_SELECT', ... })` (app-desktop
 * `gui/WindowCommandsAndDialogs/commands/openNote.ts` lines 18-23). A plugin cannot pass a window
 * id, so "which window does openNote navigate?" has exactly one answer: the focused one. Called
 * straight from a secondary editor window it would rearrange THAT window — the opposite of what
 * clicking the chip means, which is why 0.2.1 disabled the click actions there instead.
 *
 * HOW THE SWITCH IS ISSUED. No plugin API focuses a window, so this borrows a core command that
 * does it as a side effect. Normally `focusElementSideBar` (app-desktop
 * `gui/Sidebar/commands/focusElementSideBar.ts` lines 19-23), which calls
 * `bridge().switchToMainWindow()` under the comment "The sidebar is only present in the main
 * window"; that is `switchToWindow(defaultWindowId)` (app-desktop `bridge.ts` lines 358-368), which
 * calls `targetWindow.show()` unless the main window is already active — and Electron's `show()`
 * raises AND focuses. Its only other effect is to scroll and focus the sidebar tree
 * (`gui/Sidebar/hooks/useFocusHandler.ts`, `focusSidebar`): no dispatch, no navigation. When the
 * sidebar is HIDDEN that command is a no-op, so the fallback is `focusElementNoteList(noteId)`
 * (`gui/NoteList/commands/focusElementNoteList.ts` line 21), which carries the same
 * `switchToMainWindow()`. It is only the fallback because it ALSO focuses and marks the note-list
 * row, and that is exactly what separates this plugin's double click from its single click; a
 * single click then finishes by putting focus back in the editor body, which hides the difference
 * again.
 *
 * The switch command is executed WITHOUT the swallowing `tryExecute`: it is core's own command, its
 * failure is not routine, and a throw here must be reportable as its own cause rather than look
 * like a window that would not focus.
 *
 * HOW IT IS CONFIRMED. By ping and echo — see `awaitMainWindowPingReply`. Not by a sleep, and
 * deliberately not by comparing Joplin's selected note against the main window's note: those two
 * agree trivially whenever both windows happen to be showing the same note, which is the NORMAL
 * state right after "Open in new window" and after every successful click, so it would confirm
 * nothing exactly when it matters most.
 */
async function handOverToMainWindow(noteId: string): Promise<HandoffFailure | null> {
	const sidebarVisible = await sidebarIsVisible();
	try {
		if (sidebarVisible) {
			await joplin.commands.execute('focusElementSideBar');
		} else {
			await joplin.commands.execute('focusElementNoteList', noteId);
		}
	} catch (error) {
		console.warn('[whereabouts] the window-switch command failed', error);
		return 'switch-failed';
	}

	const confirmed = await awaitMainWindowPingReply(Date.now() + HANDOFF_TIMEOUT_MS);
	if (confirmed) return null;
	// A window that has never reported at all is a different problem from one that reported but
	// never answered a ping, and the two need different things from the user.
	return mainWindowReport ? 'not-confirmed' : 'no-main-editor';
}

/**
 * After the fact: check that the navigation really landed in the main window.
 *
 * Two things have to be true, and they are checked once, without retrying — re-issuing `openNote`
 * on a guess could navigate a window a second time, and the useful outcome here is a precise log
 * line, not another attempt.
 *  - Joplin's root state is on the note (`workspace.selectedNote()`), and
 *  - the MAIN window's editor says it is holding that note, in an answer to a fresh ping.
 * The second is the load-bearing half: the first is also true if the dispatch went into the
 * secondary window's slice, since that window was already showing this note.
 */
async function verifyLandedInMainWindow(noteId: string): Promise<void> {
	let selectedId = '';
	try {
		selectedId = (await joplin.workspace.selectedNote())?.id ?? '';
	} catch (error) {
		selectedId = '';
	}
	const report = await awaitMainWindowPingReply(Date.now() + VERIFY_TIMEOUT_MS, noteId);
	if (selectedId === noteId && report) return;
	console.warn(
		`[whereabouts] could not confirm the action landed in the main window (root note ${
			selectedId || 'unknown'
		}, main window ${report ? report.noteId : 'did not answer'}); not retrying`,
	);
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

	// A click in a SECONDARY editor window means "go there in the main window": both navigation
	// actions run against the focused window's state, so the main window has to be focused first.
	// `move` is exempt — it moves by explicit id and mounts its picker in the window that asked, so
	// it must stay in the secondary window (that is the 0.2.1 behaviour, unchanged).
	const handOver = message.secondary && message.action !== 'move';
	if (handOver) {
		const failure = await handOverToMainWindow(note.id);
		if (failure) {
			console.warn(
				`[whereabouts] not running "${message.action}": ${describeHandoffFailure(failure)}; ` +
					'leaving both windows untouched',
			);
			return { ok: false, error: `could not hand focus to the main window (${failure})` };
		}
	}

	try {
		switch (message.action) {
			case 'filter':
				await doFilter(note.id, folderId);
				// A single click must not move focus, in any window — that is what tells it apart
				// from a double click. The switch above had to focus SOMETHING in the main window
				// (the sidebar tree, or the note list when the sidebar is hidden), so put focus back
				// where a single click leaves it: the note body. The main window is the focused one
				// by now — confirmed, not assumed — so this window command lands there.
				if (handOver) {
					await tryExecute('focusElementNoteBody');
					await verifyLandedInMainWindow(note.id);
				}
				return { ok: true };
			case 'reveal':
				await doReveal(note.id);
				if (handOver) await verifyLandedInMainWindow(note.id);
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
			// A request from a MAIN-window editor is the plugin's only window-identity signal, and
			// one carrying a nonce is its only proof that Joplin routed an editor command to that
			// window — i.e. that the main window has focus. Both are what `handOverToMainWindow`
			// waits for. Recorded here rather than in buildState() so the fact is captured even when
			// the state itself turns out to be empty.
			if (!message.secondary) {
				mainWindowReport = {
					noteId: typeof message.noteId === 'string' ? message.noteId : '',
					at: Date.now(),
					nonce: typeof message.nonce === 'string' ? message.nonce : '',
				};
			}
			return buildState(message.noteId);
		case 'action':
			return handleAction(message);
		default:
			return null;
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

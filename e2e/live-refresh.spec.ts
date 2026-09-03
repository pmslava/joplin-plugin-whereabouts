import { test, expect } from '@playwright/test';
import { closeJoplin, launchJoplin, type JoplinInstance } from './launch';
import { connectDataApi, seedNotebooks, NOTE_IN_GAMMA_TITLE, type DataApi, type SeedData } from './dataApi';
import {
	CHIP_LABEL,
	SETTLE,
	expandAllNotebooks,
	selectAllNotes,
	selectNoteByTitle,
	selectNotebookByTitle,
	waitForChip,
} from './helpers';

/**
 * The chip must stay truthful while Joplin is running, through both of the routes it has for
 * noticing that its answer went stale.
 *
 * 1. A note MOVED to another notebook raises `joplin.workspace.onNoteChange`, so the plugin pings
 *    the editor and the chip updates promptly. This also proves the memoised notebook paths are
 *    invalidated on that event rather than serving the old parent.
 * 2. A notebook RENAMED raises NO plugin event whatsoever. Nothing tells the plugin. The ONLY thing
 *    that catches it is each editor re-asking on its timer, and the path memo expiring. This is the
 *    single reason the poll exists, and this test is what stops someone deleting it as "wasteful".
 *
 * NOT COVERED HERE — changing a Whereabouts SETTING at runtime. Joplin's Options screen is opened
 * by an Electron menu item whose Ctrl+, accelerator is handled in the browser process, so a
 * Playwright-synthesised key never reaches it, and the Data API has no settings route (its table is
 * ping/notes/folders/tags/resources/master_keys/search/services/auth/events/revisions/mcp). The
 * settings themselves are covered by the seeded-launch specs, and the live-update PIPELINE they
 * travel down — settings.onChange -> refresh ping -> editor re-asks -> chip re-renders — is the
 * same pipeline this spec exercises end to end.
 */
test.describe('Whereabouts — the chip keeps up while Joplin runs', () => {
	let joplin: JoplinInstance;
	let seed: SeedData;
	let api: DataApi;

	test.beforeAll(async () => {
		joplin = await launchJoplin();
		api = await connectDataApi(joplin.apiToken);
		seed = await seedNotebooks(api);
		await joplin.win.waitForTimeout(SETTLE * 2);
		await expandAllNotebooks(joplin.win);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('follows the note when it is moved to another notebook', async () => {
		const { win } = joplin;
		// From ALL NOTES, not from the Gamma notebook. Moving a note OUT of the notebook whose list is
		// on screen makes Joplin drop it from that list and unload it from the editor, so the chip
		// would correctly vanish rather than re-label — which tests Joplin, not Whereabouts. In the
		// All-notes view the note stays selected and open, and the chip has to re-label in place.
		await selectAllNotes(win);
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });

		await api.moveNote(seed.noteInGamma.id, seed.beta.id);

		await expect(win.locator(CHIP_LABEL)).toHaveText('Beta', { timeout: 30_000 });

		// Put it back so the rename test below starts from a known place.
		await api.moveNote(seed.noteInGamma.id, seed.gamma.id);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
	});

	test('picks up a notebook rename, which fires no plugin event at all', async () => {
		const { win } = joplin;
		await selectNotebookByTitle(win, 'Gamma');
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		// (A rename leaves the note where it is, so the notebook view is safe to use here.)
		await waitForChip(win);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });

		await api.renameFolder(seed.gamma.id, 'Gamma Renamed');

		// Nothing notified the plugin: this can only arrive via the editor's poll once the memoised
		// path expires. Generous timeout — the poll backs off to 5s when idle and the memo lives 10s.
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma Renamed', { timeout: 60_000 });

		await api.renameFolder(seed.gamma.id, 'Gamma');
	});
});

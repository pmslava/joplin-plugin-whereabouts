import { test, expect } from '@playwright/test';
import { closeJoplin, findSecondaryWindow, launchJoplin, type JoplinInstance } from './launch';
import { connectDataApi, seedNotebooks, NOTE_IN_BETA_TITLE, NOTE_IN_GAMMA_TITLE, type SeedData } from './dataApi';
import {
	CHIP_BUTTON,
	CHIP_LABEL,
	SETTLE,
	chipNoteId,
	expandAllNotebooks,
	openNoteInNewWindow,
	selectNoteByTitle,
	selectNotebookByTitle,
	selectedSidebarFolderId,
	waitForChip,
} from './helpers';
import type { Page } from '@playwright/test';

/**
 * The regression test for the worst bug this plugin can have: showing the WRONG notebook.
 *
 * `joplin.workspace.selectedNote()` reads the ROOT redux state, and Joplin's WINDOW_FOCUS reducer
 * swaps the focused window's state into root. A plugin that asks it "which note is open?" is really
 * asking "which note does the focused window have open?" — so with two editor windows, both chips
 * would name the focused window's notebook, and the answer would FLIP as focus moved. The fix is
 * that each editor sends its own note id (from CodeMirror's noteIdFacet); this spec is what proves
 * it, by asserting both chips in BOTH focus states.
 */
test.describe('Whereabouts — secondary editor window', () => {
	let joplin: JoplinInstance;
	let seed: SeedData;
	let secondary: Page;

	test.beforeAll(async () => {
		joplin = await launchJoplin();
		const api = await connectDataApi(joplin.apiToken);
		seed = await seedNotebooks(api);
		await joplin.win.waitForTimeout(SETTLE * 2);
		await expandAllNotebooks(joplin.win);

		// Open "Note in Beta" in its own window, then leave the MAIN window on "Note in Gamma", so
		// the two windows hold notes in different notebooks and a mix-up is visible.
		await selectNotebookByTitle(joplin.win, 'Beta');
		await selectNoteByTitle(joplin.win, NOTE_IN_BETA_TITLE);
		await openNoteInNewWindow(joplin.win);

		const found = await findSecondaryWindow(joplin.browser, joplin.win, 30_000);
		expect(found, 'a secondary window should open on Ctrl+Alt+N').not.toBeNull();
		secondary = found as Page;

		await selectNotebookByTitle(joplin.win, 'Gamma');
		await selectNoteByTitle(joplin.win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(joplin.win);
		await waitForChip(secondary);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('each window names its OWN notebook, whichever window has focus', async () => {
		const { win } = joplin;

		// Focus the main window.
		await win.bringToFront();
		await win.waitForTimeout(SETTLE);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		await expect(secondary.locator(CHIP_LABEL)).toHaveText('Beta', { timeout: 30_000 });
		expect(await chipNoteId(win)).toBe(seed.noteInGamma.id);
		expect(await chipNoteId(secondary)).toBe(seed.noteInBeta.id);

		// Focus the secondary window. Before the fix this is where both chips said "Beta".
		await secondary.bringToFront();
		await secondary.waitForTimeout(SETTLE);
		await expect(secondary.locator(CHIP_LABEL)).toHaveText('Beta', { timeout: 30_000 });
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		expect(await chipNoteId(secondary)).toBe(seed.noteInBeta.id);
		expect(await chipNoteId(win)).toBe(seed.noteInGamma.id);
	});

	test('the secondary window\'s chip is inert', async () => {
		const { win } = joplin;
		await win.bringToFront();
		await win.waitForTimeout(SETTLE);

		const folderBefore = await selectedSidebarFolderId(win);
		const noteBefore = await chipNoteId(win);

		// It must render as non-interactive...
		await expect(secondary.locator('[data-whereabouts-chip]')).toHaveClass(/-inert/);

		// ...and clicking it must not reach into the main window's sidebar or note selection.
		await secondary.locator(CHIP_BUTTON).first().click();
		await secondary.waitForTimeout(SETTLE * 2);

		expect(await selectedSidebarFolderId(win)).toBe(folderBefore);
		expect(await chipNoteId(win)).toBe(noteBefore);
		expect(await chipNoteId(secondary)).toBe(seed.noteInBeta.id);
	});
});

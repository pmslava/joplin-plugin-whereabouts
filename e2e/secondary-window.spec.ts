import { test, expect } from '@playwright/test';
import { closeJoplin, findSecondaryWindow, launchJoplin, type JoplinInstance } from './launch';
import {
	connectDataApi,
	seedNotebooks,
	NOTE_IN_BETA_TITLE,
	NOTE_IN_GAMMA_TITLE,
	type DataApi,
	type SeedData,
} from './dataApi';
import {
	CHIP_BUTTON,
	CHIP_LABEL,
	SETTLE,
	chipNoteId,
	closeAnyOpenDialog,
	expandAllNotebooks,
	folderPickerOpen,
	openDialogClasses,
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
	let api: DataApi;

	test.beforeAll(async () => {
		joplin = await launchJoplin();
		api = await connectDataApi(joplin.apiToken);
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

	// A modal <dialog> swallows every interaction in its window, so never let one survive a test —
	// and here it can be open in either window.
	test.afterEach(async () => {
		if (secondary) await closeAnyOpenDialog(secondary);
		if (joplin) await closeAnyOpenDialog(joplin.win);
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

	test('the secondary window\'s chip offers move only, and a left click still changes nothing', async () => {
		const { win } = joplin;
		await win.bringToFront();
		await win.waitForTimeout(SETTLE);

		const folderBefore = await selectedSidebarFolderId(win);
		const noteBefore = await chipNoteId(win);

		// Right-click works here, left-click does not — so the chip is marked move-only rather than
		// fully inert, and it must NOT be dimmed as an unusable control.
		const host = secondary.locator('[data-whereabouts-chip]');
		await expect(host).toHaveClass(/-move-only/);
		await expect(host).not.toHaveClass(/-inert/);

		// The navigation half stays disabled: a left click must not reach into the main window's
		// sidebar or note selection.
		await secondary.locator(CHIP_BUTTON).first().click();
		await secondary.waitForTimeout(SETTLE * 2);

		expect(await selectedSidebarFolderId(win)).toBe(folderBefore);
		expect(await chipNoteId(win)).toBe(noteBefore);
		expect(await chipNoteId(secondary)).toBe(seed.noteInBeta.id);
	});

	test('a right click opens the move picker INSIDE the secondary window, and cancelling moves nothing', async () => {
		const { win } = joplin;
		await secondary.bringToFront();
		await secondary.waitForTimeout(SETTLE);

		await secondary.locator(CHIP_BUTTON).first().click({ button: 'right' });

		// The picker must belong to the window the user right-clicked in. Joplin's secondary editor
		// window mounts its own WindowCommandsAndDialogs, so the dialog is in THAT document — this is
		// the whole reason move is safe here while navigation is not.
		await expect
			.poll(
				async () =>
					(await folderPickerOpen(secondary))
						? 'prompt-dialog open'
						: `open dialogs: ${(await openDialogClasses(secondary)).join(' | ') || 'none'}`,
				{ timeout: 20_000 },
			)
			.toBe('prompt-dialog open');
		// ...and NOT in the main window.
		expect(await folderPickerOpen(win), 'no picker in the main window').toBe(false);

		await secondary.keyboard.press('Escape');
		await expect.poll(() => folderPickerOpen(secondary), { timeout: 20_000 }).toBe(false);

		// Cancelling must leave the note where it was — checked at the data layer, not the UI.
		const note = await api.get<{ id: string; parent_id: string }>(
			`/notes/${seed.noteInBeta.id}?fields=id,parent_id`,
		);
		expect(note.parent_id).toBe(seed.beta.id);
		await expect(secondary.locator(CHIP_LABEL)).toHaveText('Beta');
	});
});

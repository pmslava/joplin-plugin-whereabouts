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
	CHIP_HOST,
	CHIP_LABEL,
	SETTLE,
	chipNoteId,
	closeAnyOpenDialog,
	expandAllNotebooks,
	folderPickerOpen,
	openDialogClasses,
	openNoteInNewWindow,
	revealedNoteListId,
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

	/**
	 * Put the two windows back into the starting arrangement: the MAIN window on "Note in Gamma",
	 * the secondary one on "Note in Beta", and the secondary window brought to the front.
	 *
	 * Both click tests move the main window to Beta, so each has to reset it first.
	 *
	 * WHAT THE TWO CLICK TESTS BELOW DO AND DO NOT PROVE. They do NOT prove the focus TRANSFER, and
	 * no test in this harness can: under a bare Xvfb server with no window manager, Joplin's root
	 * redux state stays the main window's for the whole run. `bringToFront()` (CDP) and an
	 * in-renderer `window.focus()` were both measured against the plugin's own view of
	 * `workspace.selectedNote()` and neither makes Electron fire the focus event that dispatches
	 * `WINDOW_FOCUS`, and every document reports `hasFocus() === true` at the same time. Delete the
	 * hand-off entirely and these two tests would still pass, because `openNote` reaches the main
	 * window either way here. THE TRANSFER IS VERIFIED ONLY BY RUNNING IT BY HAND ON A REAL DESKTOP.
	 *
	 * What they do prove, and would catch:
	 *  - the chip is live in a secondary window, and knows it is in one (`data-secondary`, asserted
	 *    per window below — that assertion exists because dropping the `-move-only` class removed
	 *    the only other outside evidence that the window detection works at all);
	 *  - the plugin's confirmation is reachable and satisfied: an unconfirmed hand-off refuses to
	 *    navigate anything, so a broken probe shows up here as nothing moving;
	 *  - the effect lands in the MAIN window's sidebar, editor and note list, and the secondary
	 *    window keeps its own note;
	 *  - the single/double distinction survives the crossing: the single click leaves the main
	 *    window's note list WITHOUT focus, the double click leaves it focused with the row marked.
	 */
	async function armFromSecondaryWindow(): Promise<void> {
		const { win } = joplin;
		await win.bringToFront();
		await win.waitForTimeout(SETTLE);
		await selectNotebookByTitle(win, 'Gamma');
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });

		await secondary.bringToFront();
		await secondary.waitForTimeout(SETTLE);
		await expect(secondary.locator(CHIP_LABEL)).toHaveText('Beta', { timeout: 30_000 });
	}

	test('each chip knows which window it is in', async () => {
		const { win } = joplin;
		// The entire secondary-window behaviour is keyed off this one flag (ownerDocument !== the
		// main window's document). Every other assertion in this file would pass just as happily
		// against a chip that had decided it was in the main window, so assert the flag itself.
		await expect(win.locator(CHIP_HOST).first()).toHaveAttribute('data-secondary', 'false');
		await expect(secondary.locator(CHIP_HOST).first()).toHaveAttribute('data-secondary', 'true');
	});

	test('a left click hands focus to the MAIN window and selects the notebook and note there', async () => {
		const { win } = joplin;
		await armFromSecondaryWindow();

		// The chip is a live control in a secondary window now — no "move only" affordance left.
		const host = secondary.locator(CHIP_HOST);
		await expect(host).toHaveAttribute('data-secondary', 'true');
		await expect(host).not.toHaveClass(/-move-only/);
		await expect(host).not.toHaveClass(/-inert/);

		await secondary.locator(CHIP_BUTTON).first().click();

		// The action lands in the MAIN window: its sidebar selects Beta and it opens the note the
		// secondary window was showing. Before 0.3.0 the click was inert and nothing here moved.
		await expect.poll(() => selectedSidebarFolderId(win), { timeout: 30_000 }).toBe(seed.beta.id);
		await expect.poll(() => chipNoteId(win), { timeout: 30_000 }).toBe(seed.noteInBeta.id);
		await expect(win.locator('input.title-input')).toHaveValue(NOTE_IN_BETA_TITLE, { timeout: 30_000 });

		// A single click must not steal focus, and that rule now has to hold ACROSS windows: the
		// hand-off had to focus the main window's sidebar to switch to it, so the plugin puts focus
		// back in the note body afterwards. If it did not, or if the gesture were routed to reveal,
		// the note list would be holding focus here.
		expect(await revealedNoteListId(win)).toBe('');

		// ...and the secondary window is left exactly where it was, still on its own note.
		await expect(secondary.locator('input.title-input')).toHaveValue(NOTE_IN_BETA_TITLE);
		expect(await chipNoteId(secondary)).toBe(seed.noteInBeta.id);
		await expect(secondary.locator(CHIP_LABEL)).toHaveText('Beta');
	});

	test('a double click also reveals the note in the MAIN window\'s note list', async () => {
		const { win } = joplin;
		await armFromSecondaryWindow();

		await secondary.locator(CHIP_BUTTON).first().dblclick();

		// Same navigation as the single click...
		await expect.poll(() => selectedSidebarFolderId(win), { timeout: 30_000 }).toBe(seed.beta.id);
		await expect.poll(() => chipNoteId(win), { timeout: 30_000 }).toBe(seed.noteInBeta.id);
		// ...plus the reveal half, which is what separates the two gestures: core's `focusNote`
		// focuses the LIST CONTAINER and marks the row through aria-activedescendant. Same check as
		// actions.spec.ts, but read from the main window while the click happened in the other one.
		await expect.poll(() => revealedNoteListId(win), { timeout: 30_000 }).toBe(seed.noteInBeta.id);

		// The secondary window is still on its own note, unrevealed and unmoved.
		await expect(secondary.locator('input.title-input')).toHaveValue(NOTE_IN_BETA_TITLE);
		expect(await chipNoteId(secondary)).toBe(seed.noteInBeta.id);
	});

	test('a right click opens the move picker INSIDE the secondary window, and cancelling moves nothing', async () => {
		const { win } = joplin;
		await secondary.bringToFront();
		await secondary.waitForTimeout(SETTLE);

		await secondary.locator(CHIP_BUTTON).first().click({ button: 'right' });

		// The picker must belong to the window the user right-clicked in. Joplin's secondary editor
		// window mounts its own WindowCommandsAndDialogs, so the dialog is in THAT document — which
		// is why move is the one action that stays in this window instead of being handed to the
		// main one: you are filing the note you are looking at.
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

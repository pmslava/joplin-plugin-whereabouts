import { test, expect } from '@playwright/test';
import { closeJoplin, launchJoplin, type JoplinInstance } from './launch';
import { connectDataApi, seedNotebooks, NOTE_IN_GAMMA_TITLE, type DataApi, type SeedData } from './dataApi';
import {
	CHIP_BUTTON,
	CHIP_LABEL,
	SETTLE,
	blurToTitleInput,
	chipNoteId,
	expandAllNotebooks,
	revealedNoteListId,
	closeAnyOpenDialog,
	folderPickerOpen,
	openDialogClasses,
	selectAllNotes,
	selectNoteByTitle,
	selectedSidebarFolderId,
	waitForChip,
} from './helpers';

/**
 * The three click actions, asserted through their COMMAND EFFECTS rather than through timers.
 *
 * The single/double distinction is the interesting one. Both actions call `openNote`, so "did the
 * notebook get selected?" cannot tell them apart. What separates them is that reveal additionally
 * runs `focusElementNoteList`, which moves DOM focus onto the note-list row — so focus is the
 * observable that proves the 250ms debounce routed the gesture correctly. A broken debounce that
 * ran reveal on every single click would steal focus out of the editor on every click; that is the
 * regression these two tests catch.
 */
test.describe('Whereabouts — click actions', () => {
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

	// A modal <dialog> blocks every interaction in the window, so never let one survive a test.
	test.afterEach(async () => {
		if (joplin) await closeAnyOpenDialog(joplin.win);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('a single click filters WITHOUT moving focus to the note list', async () => {
		const { win } = joplin;
		await selectAllNotes(win);
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		await blurToTitleInput(win);

		await win.locator(CHIP_BUTTON).first().click();

		// The filter effect lands...
		await expect.poll(() => selectedSidebarFolderId(win), { timeout: 30_000 }).toBe(seed.gamma.id);
		// ...and, crucially, the reveal effect does NOT: focus stayed where it was.
		expect(await revealedNoteListId(win)).toBe('');
		expect(await chipNoteId(win)).toBe(seed.noteInGamma.id);
	});

	test('a double click reveals the note in the list', async () => {
		const { win } = joplin;
		await selectAllNotes(win);
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		await blurToTitleInput(win);

		await win.locator(CHIP_BUTTON).first().dblclick();

		// revealInNotebook does not exist in 3.7.14 (core PR laurent22/joplin#16354 is unmerged), so
		// this exercises the fallback: openNote + focusElementNoteList.
		await expect.poll(() => revealedNoteListId(win), { timeout: 30_000 }).toBe(seed.noteInGamma.id);
		expect(await selectedSidebarFolderId(win)).toBe(seed.gamma.id);
		// The note the user was reading is still the note that is open.
		expect(await chipNoteId(win)).toBe(seed.noteInGamma.id);
	});

	test('a right click opens the "Move to notebook" picker and moves nothing on cancel', async () => {
		const { win } = joplin;
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });

		await win.locator(CHIP_BUTTON).first().click({ button: 'right' });

		// Report what WAS open when nothing matched, so a DOM change is diagnosable from the failure.
		await expect
			.poll(
				async () =>
					(await folderPickerOpen(win))
						? 'prompt-dialog open'
						: `open dialogs: ${(await openDialogClasses(win)).join(' | ') || 'none'}`,
				{ timeout: 20_000 },
			)
			.toBe('prompt-dialog open');

		await win.keyboard.press('Escape');
		await expect.poll(() => folderPickerOpen(win), { timeout: 20_000 }).toBe(false);

		// Cancelling must leave the note exactly where it was — checked at the data layer, not the UI.
		const note = await api.get<{ id: string; parent_id: string }>(
			`/notes/${seed.noteInGamma.id}?fields=id,parent_id`,
		);
		expect(note.parent_id).toBe(seed.gamma.id);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma');
	});
});

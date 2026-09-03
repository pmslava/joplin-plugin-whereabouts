import { test, expect } from '@playwright/test';
import { closeJoplin, launchJoplin, type JoplinInstance } from './launch';
import { connectDataApi, seedNotebooks, NOTE_IN_BETA_TITLE, NOTE_IN_GAMMA_TITLE, type SeedData } from './dataApi';
import {
	CHIP_BUTTON,
	CHIP_HOST,
	CHIP_LABEL,
	SETTLE,
	chipNoteId,
	chipPosition,
	expandAllNotebooks,
	nativePillState,
	selectAllNotes,
	selectNoteByTitle,
	selectNotebookByTitle,
	selectedSidebarFolderId,
	restoreSplitLayout,
	switchToViewerOnly,
	waitForChip,
} from './helpers';

/**
 * The core behaviour, all against the DEFAULT settings (below-title, notebook name only, native pill
 * hidden). One Joplin launch covers every assertion here, because none of them needs a different
 * startup configuration — the placement and path-mode variants get their own spec files.
 */
test.describe('Whereabouts chip — defaults', () => {
	let joplin: JoplinInstance;
	let seed: SeedData;

	test.beforeAll(async () => {
		joplin = await launchJoplin();
		const api = await connectDataApi(joplin.apiToken);
		seed = await seedNotebooks(api);
		await joplin.win.waitForTimeout(SETTLE * 2);
		await expandAllNotebooks(joplin.win);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('shows the notebook name in the native pill slot for a note in a plain notebook view', async () => {
		const { win } = joplin;
		await selectNotebookByTitle(win, 'Gamma');
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);

		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		// below-title = the chip is .note-title-wrapper's immediate next sibling, i.e. the exact slot
		// Joplin's own "In: <Notebook>" pill occupies.
		expect(await chipPosition(win)).toBe('below-title');
		expect(await chipNoteId(win)).toBe(seed.noteInGamma.id);
	});

	test('updates when a note in a different notebook is selected', async () => {
		const { win } = joplin;
		await selectNotebookByTitle(win, 'Beta');
		await selectNoteByTitle(win, NOTE_IN_BETA_TITLE);

		await expect(win.locator(CHIP_LABEL)).toHaveText('Beta', { timeout: 30_000 });
		expect(await chipNoteId(win)).toBe(seed.noteInBeta.id);

		// ...and back again, so this proves a live update rather than a lucky first render.
		await selectNotebookByTitle(win, 'Gamma');
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
	});

	test('survives a viewer-only layout', async () => {
		const { win } = joplin;
		await selectNotebookByTitle(win, 'Gamma');
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);

		await switchToViewerOnly(win);

		// The CodeMirror component still renders (hidden), so the content script — and therefore the
		// chip — is still alive. This is the regression guard for anyone tempted to mount the chip
		// from something that only exists while the editor pane is visible.
		await expect(win.locator(CHIP_HOST)).toBeAttached();
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		expect(await chipPosition(win)).toBe('below-title');

		// Back to the default split layout for the remaining tests.
		await restoreSplitLayout(win);
	});

	test('hides Joplin\'s own "In: <Notebook>" pill in All notes', async () => {
		const { win } = joplin;
		await selectAllNotes(win);
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });

		// "hidden", not "absent": the pill IS rendered by Joplin in this view, and our CSS is what
		// takes it off screen. Asserting only "not visible" would also pass if the pill had simply
		// never been rendered, which would make this test meaningless.
		expect(await nativePillState(win)).toBe('hidden');
	});

	test('left-click selects the notebook in the sidebar and keeps the same note open', async () => {
		const { win } = joplin;
		// Start from All notes, so the click has a notebook to actually move the sidebar TO.
		await selectAllNotes(win);
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		expect(await selectedSidebarFolderId(win)).not.toBe(seed.gamma.id);

		await win.locator(CHIP_BUTTON).first().click();

		// FOLDER_AND_NOTE_SELECT: the sidebar moves to the notebook AND the note stays open. If this
		// ever regresses to `openFolder`, the note id below changes to the folder's last-viewed note.
		await expect
			.poll(() => selectedSidebarFolderId(win), { timeout: 30_000 })
			.toBe(seed.gamma.id);
		expect(await chipNoteId(win)).toBe(seed.noteInGamma.id);
		await expect(win.locator('input.title-input')).toHaveValue(NOTE_IN_GAMMA_TITLE);
	});
});

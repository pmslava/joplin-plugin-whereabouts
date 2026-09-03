import { test, expect } from '@playwright/test';
import { closeJoplin, launchJoplin, type JoplinInstance } from './launch';
import { connectDataApi, seedNotebooks, NOTE_IN_BETA_TITLE } from './dataApi';
import {
	CHIP_LABEL,
	SETTLE,
	expandAllNotebooks,
	selectNoteByTitle,
	selectNotebookByTitle,
	waitForChip,
} from './helpers';

/**
 * pathMode=full must render the whole ancestry, root-first, joined by the separator setting. Beta is
 * seeded as a child of Alpha specifically to make this assertable.
 */
test.describe('Whereabouts chip — full path mode', () => {
	let joplin: JoplinInstance;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ seed: { pathMode: 'full' } });
		const api = await connectDataApi(joplin.apiToken);
		await seedNotebooks(api);
		await joplin.win.waitForTimeout(SETTLE * 2);
		await expandAllNotebooks(joplin.win);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('shows "Alpha / Beta" for a note in a nested notebook', async () => {
		const { win } = joplin;
		await selectNotebookByTitle(win, 'Beta');
		await selectNoteByTitle(win, NOTE_IN_BETA_TITLE);
		await waitForChip(win);

		await expect(win.locator(CHIP_LABEL)).toHaveText('Alpha / Beta', { timeout: 30_000 });
	});
});

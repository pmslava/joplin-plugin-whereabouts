import { test, expect } from '@playwright/test';
import { closeJoplin, launchJoplin, type JoplinInstance } from './launch';
import { connectDataApi, seedNotebooks, NOTE_IN_GAMMA_TITLE } from './dataApi';
import {
	CHIP_LABEL,
	SETTLE,
	expandAllNotebooks,
	nativePillState,
	selectAllNotes,
	selectNoteByTitle,
	waitForChip,
} from './helpers';

/**
 * The other half of the hideNativePill test (the "hidden" half lives in chip.spec.ts): with the
 * setting off, Joplin's own "In: <Notebook>" button must still be visible in All notes. Together the
 * two prove the CSS rule is actually driven by the setting rather than always-on or always-off.
 */
test.describe('Whereabouts — hideNativePill off', () => {
	let joplin: JoplinInstance;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ seed: { hideNativePill: false } });
		const api = await connectDataApi(joplin.apiToken);
		await seedNotebooks(api);
		await joplin.win.waitForTimeout(SETTLE * 2);
		await expandAllNotebooks(joplin.win);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('leaves Joplin\'s own pill visible in All notes', async () => {
		const { win } = joplin;
		await selectAllNotes(win);
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);
		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });

		await expect.poll(() => nativePillState(win), { timeout: 20_000 }).toBe('visible');
	});
});

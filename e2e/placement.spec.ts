import { test, expect } from '@playwright/test';
import { closeJoplin, launchJoplin, type JoplinInstance } from './launch';
import { connectDataApi, seedNotebooks, NOTE_IN_GAMMA_TITLE } from './dataApi';
import {
	CHIP_LABEL,
	SETTLE,
	chipPosition,
	expandAllNotebooks,
	selectNoteByTitle,
	selectNotebookByTitle,
	waitForChip,
} from './helpers';

/**
 * The two non-default placements. Each needs its own Joplin launch because the placement is read
 * from the profile's seeded settings at startup; there is no GUI route to a plugin setting that
 * Playwright can drive reliably.
 *
 * These assertions pin the chip to the two containers that survive React re-rendering the title bar
 * (a direct child of .note-title-wrapper, or a direct child of .editor-toolbar). If someone "tidies"
 * the chip into a toolbar `.group` instead, these fail — which is the point.
 */
test.describe('Whereabouts chip — inline-right placement', () => {
	let joplin: JoplinInstance;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ seed: { placement: 'inline-right' } });
		const api = await connectDataApi(joplin.apiToken);
		await seedNotebooks(api);
		await joplin.win.waitForTimeout(SETTLE * 2);
		await expandAllNotebooks(joplin.win);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('sits inside the title row, right after the title input', async () => {
		const { win } = joplin;
		await selectNotebookByTitle(win, 'Gamma');
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);

		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		await expect.poll(() => chipPosition(win), { timeout: 20_000 }).toBe('inline-right');
	});
});

test.describe('Whereabouts chip — toolbar-first placement', () => {
	let joplin: JoplinInstance;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ seed: { placement: 'toolbar-first' } });
		const api = await connectDataApi(joplin.apiToken);
		await seedNotebooks(api);
		await joplin.win.waitForTimeout(SETTLE * 2);
		await expandAllNotebooks(joplin.win);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('is the first item of the note toolbar and wears the native toolbar-button classes', async () => {
		const { win } = joplin;
		await selectNotebookByTitle(win, 'Gamma');
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForChip(win);

		await expect(win.locator(CHIP_LABEL)).toHaveText('Gamma', { timeout: 30_000 });
		await expect.poll(() => chipPosition(win), { timeout: 20_000 }).toBe('toolbar-first');

		// It must BE a toolbar button, not a lookalike, so Joplin's own sizing/hover/theme rules apply.
		const classes = await win
			.locator('[data-whereabouts-chip] .whereabouts-chip')
			.first()
			.getAttribute('class');
		expect(classes).toContain('toolbar-button');
		expect(classes).toContain('-has-title');

		// Wearing the classes is not enough. This plugin's stylesheet is linked AFTER core's, so any
		// property the .whereabouts-chip pill rules declare wins at equal specificity and would leave
		// the chip visibly out of step with the buttons beside it. Compare the COMPUTED values against
		// a real sibling toolbar button.
		const geometry = await win.evaluate(() => {
			const chip = document.querySelector('[data-whereabouts-chip] .whereabouts-chip') as HTMLElement | null;
			const toolbar = document.querySelector('.note-title-info-group .editor-toolbar');
			const sibling = toolbar?.querySelector('.group button.toolbar-button') as HTMLElement | null;
			if (!chip || !sibling) return null;
			const read = (el: HTMLElement) => {
				const cs = getComputedStyle(el);
				return {
					paddingLeft: cs.paddingLeft,
					paddingRight: cs.paddingRight,
					paddingTop: cs.paddingTop,
					paddingBottom: cs.paddingBottom,
					cursor: cs.cursor,
					display: cs.display,
					height: Math.round(el.getBoundingClientRect().height),
				};
			};
			return { chip: read(chip), sibling: read(sibling) };
		});

		expect(geometry, 'both the chip and a sibling toolbar button should be present').not.toBeNull();
		expect(geometry?.chip).toEqual(geometry?.sibling);
	});
});

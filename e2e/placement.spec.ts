import { test, expect } from '@playwright/test';
import { closeJoplin, launchJoplin, type JoplinInstance, type SeedSettings } from './launch';
import { connectDataApi, seedNotebooks, NOTE_IN_BETA_TITLE } from './dataApi';
import {
	CHIP_LABEL,
	SETTLE,
	captureTitleArea,
	chipPosition,
	compactLayout,
	expandAllNotebooks,
	measureInlineRightCentring,
	measureRowSpacing,
	measureSingleLineGap,
	selectNoteByTitle,
	selectNotebookByTitle,
	waitForChip,
} from './helpers';
import { readSingleLineGap, recordSingleLineGap } from './rhythm';

/**
 * All four placements, each in its own Joplin because the placement is read from the profile at
 * startup. Every describe uses pathMode 'full' and the nested notebook, so the chip reads
 * "Alpha / Beta" — a two-level path exercises the widest chip and makes the committed screenshots
 * show what the full-path setting actually looks like.
 *
 * Each describe also writes docs/images/placement-<name>.png. Those files are the README and
 * manifest screenshots: generating them from the suite means they cannot drift away from what the
 * plugin really renders.
 */
const seedFor = (placement: SeedSettings['placement']): SeedSettings => ({ pathMode: 'full', placement });

async function openBetaNote(joplin: JoplinInstance): Promise<void> {
	const api = await connectDataApi(joplin.apiToken);
	await seedNotebooks(api);
	await joplin.win.waitForTimeout(SETTLE * 2);
	await expandAllNotebooks(joplin.win);
	await selectNotebookByTitle(joplin.win, 'Beta');
	await selectNoteByTitle(joplin.win, NOTE_IN_BETA_TITLE);
	await waitForChip(joplin.win);
	await expect(joplin.win.locator(CHIP_LABEL)).toHaveText('Alpha / Beta', { timeout: 30_000 });
}

test.describe('placement: inline-right', () => {
	let joplin: JoplinInstance;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ seed: seedFor('inline-right') });
		await openBetaNote(joplin);
	});
	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('sits in the title row after the input, vertically centred with the note-toolbar buttons', async () => {
		const { win } = joplin;
		expect(await chipPosition(win)).toBe('title-row-after-input');

		// It must NOT have folded the row: that is the compact placement's job, not this one.
		const layout = await compactLayout(win);
		expect(layout.hasClass, 'inline-right must not apply the compact class').toBe(false);
		expect(layout.chipAndIconsSameRow, 'chip shares the title row with the icons').toBe(true);

		const c = await measureInlineRightCentring(win);
		expect(c.found, 'chip and a note-toolbar button both present').toBe(true);
		expect(
			Math.abs(c.chipCentre - c.buttonCentre),
			`chip centre ${c.chipCentre} vs toolbar button centre ${c.buttonCentre}`,
		).toBeLessThanOrEqual(1);

		// This is the rhythm every other placement has to match: with the chip inside the title row,
		// the space between the title and the editor toolbar is one plain line gap. Slava called this
		// one good, so it is the reference. Hand it to the chip-row placements.
		const gap = await measureSingleLineGap(win);
		expect(gap, 'single-line gap measured').toBeGreaterThanOrEqual(0);
		recordSingleLineGap(gap);
		// eslint-disable-next-line no-console
		console.log(`[rhythm] inline-right single-line gap = ${gap.toFixed(2)}px`);

		await captureTitleArea(win, 'inline-right');
	});
});

test.describe('placement: below-title (default)', () => {
	let joplin: JoplinInstance;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ seed: seedFor('below-title') });
		await openBetaNote(joplin);
	});
	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('sits in the native pill slot, aligned with the title text and the editor toolbar', async () => {
		const { win } = joplin;
		expect(await chipPosition(win)).toBe('below-title');

		const m = await measureRowSpacing(win);
		expect(m.found, 'title bar, chip and editor toolbar all present').toBe(true);
		// eslint-disable-next-line no-console
		console.log(`[rhythm] below-title A=${m.above.toFixed(2)}px B=${m.below.toFixed(2)}px`);

		// THE acceptance criterion: the empty space above the chip equals the space below it...
		expect(
			Math.abs(m.above - m.below),
			`A (above) ${m.above} vs B (below) ${m.below}`,
		).toBeLessThanOrEqual(1);

		// ...and both equal the plain single-line gap, so the chip row sits on Joplin's own rhythm
		// rather than reading as a banner with more air on one side.
		const reference = readSingleLineGap();
		expect(reference, 'inline-right spec must run first to record the reference gap').not.toBeNull();
		expect(Math.abs(m.above - (reference as number)), `A ${m.above} vs single-line gap ${reference}`).toBeLessThanOrEqual(1);
		expect(Math.abs(m.below - (reference as number)), `B ${m.below} vs single-line gap ${reference}`).toBeLessThanOrEqual(1);

		// The left edge still has to line up with the title text and the editor toolbar.
		expect(
			Math.abs(m.chipLeft - m.editorToolbarLeft),
			`chip left ${m.chipLeft} vs editor toolbar left ${m.editorToolbarLeft}`,
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(m.chipLeft - m.titleTextLeft),
			`chip left ${m.chipLeft} vs title text left ${m.titleTextLeft}`,
		).toBeLessThanOrEqual(1);

		await captureTitleArea(win, 'below-title');
	});
});

test.describe('placement: below-title-compact', () => {
	let joplin: JoplinInstance;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ seed: seedFor('below-title-compact') });
		await openBetaNote(joplin);
	});
	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('gives the title the full width and drops the icons onto the chip row', async () => {
		const { win } = joplin;
		// Structurally it is a child of the title row; the two-line effect is pure CSS.
		expect(await chipPosition(win)).toBe('title-row-after-input');

		const layout = await compactLayout(win);
		expect(layout.found, 'title row, chip and info group all present').toBe(true);
		expect(layout.hasClass, 'wrapper carries the compact marker class').toBe(true);
		expect(layout.titleSpansFullWidth, 'the title input has a line to itself').toBe(true);
		expect(layout.chipBelowTitle, 'chip is below the title').toBe(true);
		expect(layout.iconsBelowTitle, 'date + note-toolbar icons moved down too').toBe(true);
		expect(layout.chipAndIconsSameRow, 'chip and icons share the second row').toBe(true);
		expect(layout.chipLeftOfIcons, 'chip on the left, icons pushed right').toBe(true);

		// Same vertical rule as below-title, with the chip row's bottom taken as the lower of the chip
		// and the icons that now share its line.
		const m = await measureRowSpacing(win, true);
		expect(m.found, 'title bar, chip and editor toolbar all present').toBe(true);
		// eslint-disable-next-line no-console
		console.log(`[rhythm] below-title-compact A=${m.above.toFixed(2)}px B=${m.below.toFixed(2)}px`);
		expect(
			Math.abs(m.above - m.below),
			`A (above) ${m.above} vs B (below) ${m.below}`,
		).toBeLessThanOrEqual(1);
		const reference = readSingleLineGap();
		expect(reference, 'inline-right spec must run first to record the reference gap').not.toBeNull();
		expect(Math.abs(m.above - (reference as number)), `A ${m.above} vs single-line gap ${reference}`).toBeLessThanOrEqual(1);
		expect(Math.abs(m.below - (reference as number)), `B ${m.below} vs single-line gap ${reference}`).toBeLessThanOrEqual(1);

		await captureTitleArea(win, 'below-title-compact');
	});
});

test.describe('placement: editor-toolbar', () => {
	let joplin: JoplinInstance;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ seed: seedFor('editor-toolbar') });
		await openBetaNote(joplin);
	});
	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('is the first item of the EDITOR toolbar and matches its sibling buttons', async () => {
		const { win } = joplin;
		expect(await chipPosition(win)).toBe('editor-toolbar');

		// The editor toolbar, not the note toolbar: assert the container we landed in is the one with
		// the formatting buttons.
		const container = await win.evaluate(() => {
			const host = document.querySelector('[data-whereabouts-chip]');
			const parent = host?.parentElement ?? null;
			return {
				id: parent?.id ?? '',
				ariaLabel: parent?.getAttribute('aria-label') ?? '',
				isEditorToolbar: !!parent?.classList.contains('editor-toolbar'),
				beforeFirstGroup: parent?.querySelector('.group')
					? !!(host && parent.querySelector('.group')!.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_PRECEDING)
					: false,
			};
		});
		expect(container.id).toBe('CodeMirrorToolbar');
		expect(container.isEditorToolbar).toBe(true);
		expect(container.beforeFirstGroup, 'chip precedes the first .group').toBe(true);

		const classes = await win
			.locator('[data-whereabouts-chip] .whereabouts-chip')
			.first()
			.getAttribute('class');
		expect(classes).toContain('toolbar-button');
		expect(classes).toContain('-has-title');

		// The NAME must be on screen. In 0.1.0 the note-toolbar variant rendered icon-only because
		// core's .toolbar-button clamps width and hides overflow; this is the regression guard.
		const label = win.locator(CHIP_LABEL);
		await expect(label).toBeVisible();
		const labelBox = await label.boundingBox();
		expect(labelBox, 'label has a box').not.toBeNull();
		expect(labelBox!.width, 'label is not collapsed to zero width').toBeGreaterThan(20);

		// Wearing the classes is not enough — this sheet is linked after core's, so compare computed
		// values against a real sibling toolbar button.
		const geometry = await win.evaluate(() => {
			const chip = document.querySelector('[data-whereabouts-chip] .whereabouts-chip') as HTMLElement | null;
			const sibling = document.querySelector('#CodeMirrorToolbar .group button.toolbar-button') as HTMLElement | null;
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
		expect(geometry, 'chip and a sibling toolbar button both present').not.toBeNull();
		expect(geometry?.chip).toEqual(geometry?.sibling);

		await captureTitleArea(win, 'editor-toolbar');
	});
});

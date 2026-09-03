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
	selectNoteByTitle,
	selectNotebookByTitle,
	waitForChip,
} from './helpers';
import { readSingleLineGap, recordSingleLineGap } from './rhythm';
import { measureInkGaps, measureReferenceInkGap } from './ink';

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

		// The reference the chip-row placements must reproduce: with the chip inside the title row,
		// the BLANK PIXELS between the title's glyphs and the editor toolbar band. Slava called this
		// placement's spacing good, so this is Joplin's own rhythm. Measured in ink, not boxes.
		const gap = await measureReferenceInkGap(win);
		expect(gap, 'reference ink gap measured').toBeGreaterThanOrEqual(0);
		recordSingleLineGap(gap);
		// eslint-disable-next-line no-console
		console.log(`[ink] G_ref (inline-right, title glyphs -> toolbar band) = ${gap.toFixed(2)}px`);

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

		const ink = await measureInkGaps(win);
		expect(ink.found, 'title text, chip and toolbar band all located in the screenshot').toBe(true);
		const reference = readSingleLineGap();
		expect(reference, 'inline-right spec must run first to record the reference gap').not.toBeNull();
		// eslint-disable-next-line no-console
		console.log(
			`[ink] below-title G_above=${ink.above.toFixed(2)}px G_below=${ink.below.toFixed(2)}px G_ref=${(reference as number).toFixed(2)}px`,
		);

		// THE acceptance criterion, in pixels the reader actually sees.
		expect(
			Math.abs(ink.above - ink.below),
			`G_above ${ink.above} vs G_below ${ink.below}`,
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(ink.above - (reference as number)),
			`G_above ${ink.above} vs G_ref ${reference}`,
		).toBeLessThanOrEqual(1);

		const m = await measureRowSpacing(win);
		expect(m.found, 'title bar, chip and editor toolbar all present').toBe(true);

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

		// Same rule as below-title, measured the same way.
		const ink = await measureInkGaps(win, true);
		expect(ink.found, 'title text, chip and toolbar band all located in the screenshot').toBe(true);
		const reference = readSingleLineGap();
		expect(reference, 'inline-right spec must run first to record the reference gap').not.toBeNull();
		// eslint-disable-next-line no-console
		console.log(
			`[ink] below-title-compact G_above=${ink.above.toFixed(2)}px G_below=${ink.below.toFixed(2)}px G_ref=${(reference as number).toFixed(2)}px iconsTallerBy=${ink.iconsTallerBy.toFixed(2)}px`,
		);

		expect(
			Math.abs(ink.above - ink.below),
			`G_above ${ink.above} vs G_below ${ink.below}`,
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(ink.above - (reference as number)),
			`G_above ${ink.above} vs G_ref ${reference}`,
		).toBeLessThanOrEqual(1);

		// The icons moved onto the chip's line must not make that line taller than the chip itself,
		// or the gap below the chip would be set by them rather than by the rule above.
		expect(
			ink.iconsTallerBy,
			`the moved icons are ${ink.iconsTallerBy}px taller than the chip's box`,
		).toBeLessThanOrEqual(2);

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

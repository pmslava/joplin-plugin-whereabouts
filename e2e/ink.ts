import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';

/**
 * Pixel-level measurement of the blank space around the chip.
 *
 * Why pixels and not `getBoundingClientRect`: the acceptance criterion is what the EYE sees, and
 * boxes lie about that. Joplin's title input is 38px tall around a ~23px line box and carries 5px
 * of its own bottom padding, so its border-box bottom sits ~12px below the last inked pixel of the
 * title. A layout balanced on boxes measured A = B = 0 while the screenshot showed ~11px of air
 * above the chip and ~4px below it. So this decodes an actual screenshot and counts ink-free rows.
 *
 * This is deliberately a SECOND, independent method: the plugin positions the chip using canvas
 * text metrics, and this checks the result against rendered pixels. If the two ever disagree, the
 * assertion fails rather than both being wrong in the same way.
 */

export interface InkGaps {
	found: boolean;
	/** Ink-free rows between the title's lowest inked row and the chip's top border row. */
	above: number;
	/** Ink-free rows between the chip's bottom border row and the toolbar band's first row. */
	below: number;
	/** Diagnostic row indices, in CSS px relative to the captured area. */
	titleInkBottomRow: number;
	chipTopRow: number;
	chipBottomRow: number;
	toolbarTopRow: number;
	/** Compact only: how much taller than the chip's box the moved icons are. */
	iconsTallerBy: number;
}

interface Geometry {
	ok: boolean;
	clip: { x: number; y: number; width: number; height: number };
	dpr: number;
	titleX: { left: number; right: number };
	chipTop: number;
	chipBottom: number;
	toolbarTop: number;
	iconsTallerBy: number;
}

/** Collect, in one page evaluation, every rect the pixel scan needs. */
async function readGeometry(win: Page, compact: boolean): Promise<Geometry> {
	return win.evaluate((isCompact) => {
		const bad: Geometry = {
			ok: false,
			clip: { x: 0, y: 0, width: 0, height: 0 },
			dpr: 1,
			titleX: { left: 0, right: 0 },
			chipTop: 0,
			chipBottom: 0,
			toolbarTop: 0,
			iconsTallerBy: 0,
		};
		const wrapper = document.querySelector('.note-editor-wrapper') as HTMLElement | null;
		const input = document.querySelector('input.title-input') as HTMLElement | null;
		const chip = document.querySelector('[data-whereabouts-chip] .whereabouts-chip') as HTMLElement | null;
		const toolbar = document.querySelector('#CodeMirrorToolbar') as HTMLElement | null;
		if (!wrapper || !input || !chip || !toolbar) return bad;

		const w = wrapper.getBoundingClientRect();
		const i = input.getBoundingClientRect();
		const c = chip.getBoundingClientRect();
		const t = toolbar.getBoundingClientRect();
		const group = document.querySelector('.note-title-info-group') as HTMLElement | null;
		const g = isCompact && group ? group.getBoundingClientRect() : null;

		return {
			ok: true,
			// Capture from the top of the note editor down to just past the toolbar band.
			clip: {
				x: Math.floor(w.left),
				y: Math.floor(w.top),
				width: Math.ceil(w.width),
				height: Math.ceil(t.top - w.top) + 12,
			},
			dpr: window.devicePixelRatio || 1,
			// Scan only the title's own column, so the date label and icons on the right cannot be
			// mistaken for title ink.
			titleX: { left: i.left - Math.floor(w.left), right: i.right - Math.floor(w.left) },
			chipTop: c.top - Math.floor(w.top),
			chipBottom: c.bottom - Math.floor(w.top),
			toolbarTop: t.top - Math.floor(w.top),
			iconsTallerBy: g ? Math.max(0, g.height - c.height) : 0,
		};
	}, compact);
}

/**
 * Count ink-free rows above and below the chip.
 *
 * "Ink" is any pixel differing from the page background by more than a small threshold. The
 * background is sampled from the capture's top-right corner, which is empty in every placement.
 */
export async function measureInkGaps(win: Page, compact = false): Promise<InkGaps> {
	const empty: InkGaps = {
		found: false,
		above: -1,
		below: -1,
		titleInkBottomRow: -1,
		chipTopRow: -1,
		chipBottomRow: -1,
		toolbarTopRow: -1,
		iconsTallerBy: -1,
	};

	const geo = await readGeometry(win, compact);
	if (!geo.ok || geo.clip.width <= 0 || geo.clip.height <= 0) return empty;

	const buffer = await win.screenshot({ clip: geo.clip });
	const png = PNG.sync.read(buffer);
	// Screenshots come back in device pixels; every rect above is in CSS px.
	const scale = png.width / geo.clip.width;

	const at = (x: number, y: number) => {
		const idx = (png.width * y + x) << 2;
		return [png.data[idx], png.data[idx + 1], png.data[idx + 2]];
	};
	const [br, bg, bb] = at(png.width - 2, 1);
	const INK_THRESHOLD = 24;
	const isInk = (x: number, y: number) => {
		const [r, g, b] = at(x, y);
		return Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) > INK_THRESHOLD;
	};

	const xFrom = Math.max(0, Math.round(geo.titleX.left * scale));
	const xTo = Math.min(png.width - 1, Math.round(geo.titleX.right * scale));
	const chipTopPx = Math.round(geo.chipTop * scale);
	const chipBottomPx = Math.round(geo.chipBottom * scale);
	const toolbarTopPx = Math.round(geo.toolbarTop * scale);

	const rowHasInk = (y: number) => {
		if (y < 0 || y >= png.height) return false;
		for (let x = xFrom; x <= xTo; x++) if (isInk(x, y)) return true;
		return false;
	};

	// The title's lowest inked row, searching upward from just above the chip.
	let titleInkBottom = -1;
	for (let y = Math.min(chipTopPx - 1, png.height - 1); y >= 0; y--) {
		if (rowHasInk(y)) {
			titleInkBottom = y;
			break;
		}
	}
	if (titleInkBottom < 0) return empty;

	const toCss = (px: number) => px / scale;
	return {
		found: true,
		// Rows strictly between the two edges — the blank band the reader sees.
		//
		// The two expressions are asymmetric on purpose. `titleInkBottom` is the LAST inked row, and
		// `chipTopPx` is the FIRST row of the chip, so the blank rows between them are
		// chipTop - titleInkBottom - 1. But a rect's `bottom` is the EXCLUSIVE edge, so the chip's
		// last inked row is chipBottom - 1 and the toolbar band's first row is toolbarTop, leaving
		// toolbarTop - chipBottom blank rows. Subtracting one there as well under-reports the space
		// below the chip by a pixel and makes a balanced layout look 1px off.
		above: toCss(chipTopPx - titleInkBottom - 1),
		below: toCss(toolbarTopPx - chipBottomPx),
		titleInkBottomRow: toCss(titleInkBottom),
		chipTopRow: toCss(chipTopPx),
		chipBottomRow: toCss(chipBottomPx),
		toolbarTopRow: toCss(toolbarTopPx),
		iconsTallerBy: geo.iconsTallerBy,
	};
}

/**
 * The reference: in inline-right (no chip row at all) the blank rows between the title's glyphs and
 * the toolbar band. This is Joplin's own single-line spacing, and the number the chip's row has to
 * reproduce above AND below itself.
 */
export async function measureReferenceInkGap(win: Page): Promise<number> {
	const geo = await readGeometry(win, false);
	if (!geo.ok) return -1;

	const buffer = await win.screenshot({ clip: geo.clip });
	const png = PNG.sync.read(buffer);
	const scale = png.width / geo.clip.width;
	const at = (x: number, y: number) => {
		const idx = (png.width * y + x) << 2;
		return [png.data[idx], png.data[idx + 1], png.data[idx + 2]];
	};
	const [br, bg, bb] = at(png.width - 2, 1);
	const xFrom = Math.max(0, Math.round(geo.titleX.left * scale));
	const xTo = Math.min(png.width - 1, Math.round(geo.titleX.right * scale));
	const toolbarTopPx = Math.round(geo.toolbarTop * scale);

	let titleInkBottom = -1;
	for (let y = Math.min(toolbarTopPx - 1, png.height - 1); y >= 0; y--) {
		let ink = false;
		for (let x = xFrom; x <= xTo; x++) {
			const [r, g, b] = at(x, y);
			if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) > 24) {
				ink = true;
				break;
			}
		}
		if (ink) {
			titleInkBottom = y;
			break;
		}
	}
	if (titleInkBottom < 0) return -1;
	return (toolbarTopPx - titleInkBottom - 1) / scale;
}

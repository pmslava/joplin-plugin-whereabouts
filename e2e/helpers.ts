import { Page, expect } from '@playwright/test';

/** Joplin re-renders the title bar and note list on timers of its own; give it room to settle. */
export const SETTLE = 800;

export const CHIP_HOST = '[data-whereabouts-chip]';
export const CHIP_BUTTON = '[data-whereabouts-chip] .whereabouts-chip';
export const CHIP_LABEL = '[data-whereabouts-chip] .whereabouts-label';

/** Wait for the chip to exist at all (the plugin has to load and answer one round-trip first). */
export async function waitForChip(win: Page): Promise<void> {
	await expect(win.locator(CHIP_HOST)).toBeAttached({ timeout: 60_000 });
}

export async function chipText(win: Page): Promise<string> {
	return (await win.locator(CHIP_LABEL).first().textContent()) ?? '';
}

/** The note the chip currently speaks for, read off its observability attribute. */
export async function chipNoteId(win: Page): Promise<string> {
	return (await win.locator(CHIP_HOST).first().getAttribute('data-note-id')) ?? '';
}

/**
 * Where the chip actually sits, described relative to the title bar, so a spec can assert placement
 * without hard-coding Joplin's whole DOM shape:
 *   - 'below-title'    the chip is a SIBLING of .note-title-wrapper, immediately after it
 *                      (the exact slot Joplin's own "In: <Notebook>" pill uses)
 *   - 'inline-right'   the chip is a CHILD of .note-title-wrapper, immediately after the title input
 *   - 'toolbar-first'  the chip is the FIRST CHILD of the note toolbar
 *   - 'other'/'absent' anything else
 */
export type ChipPosition = 'below-title' | 'inline-right' | 'toolbar-first' | 'other' | 'absent';

export async function chipPosition(win: Page): Promise<ChipPosition> {
	return win.evaluate(() => {
		const host = document.querySelector('[data-whereabouts-chip]');
		if (!host) return 'absent';
		const wrapper = document.querySelector('.note-title-wrapper');
		if (!wrapper) return 'other';

		if (host.parentElement === wrapper.parentElement && wrapper.nextElementSibling === host) {
			return 'below-title';
		}
		if (host.parentElement === wrapper) {
			const input = wrapper.querySelector('input.title-input');
			if (input && input.nextElementSibling === host) return 'inline-right';
			return 'other';
		}
		const toolbar = wrapper.querySelector('.note-title-info-group .editor-toolbar');
		if (toolbar && host.parentElement === toolbar && toolbar.firstElementChild === host) {
			return 'toolbar-first';
		}
		return 'other';
	});
}

/**
 * State of Joplin's own "In: <Notebook>" pill. It only exists in Search / Tag / SmartFilter views,
 * so a spec must be able to tell "not rendered at all" from "rendered but hidden by our CSS" —
 * otherwise the hideNativePill test would pass for the wrong reason.
 *
 * The pill's <button> is styled-components-generated with no stable class, so it is identified the
 * same way the stylesheet does: a following sibling of .note-title-wrapper that is not our own chip
 * and holds a button with the notebook glyph.
 */
export type NativePillState = 'absent' | 'hidden' | 'visible';

export async function nativePillState(win: Page): Promise<NativePillState> {
	return win.evaluate(() => {
		const wrapper = document.querySelector('.note-title-wrapper');
		if (!wrapper) return 'absent';
		let el = wrapper.nextElementSibling;
		while (el) {
			if (!el.hasAttribute('data-whereabouts-chip') && el.querySelector('button > .icon-notebooks')) {
				const style = getComputedStyle(el);
				const box = (el as HTMLElement).getBoundingClientRect();
				const shown = style.display !== 'none' && style.visibility !== 'hidden' && box.height > 0;
				return shown ? 'visible' : 'hidden';
			}
			el = el.nextElementSibling;
		}
		return 'absent';
	});
}

/** The folder id the sidebar currently shows as selected, or '' when a smart filter is selected. */
export async function selectedSidebarFolderId(win: Page): Promise<string> {
	return win.evaluate(() => {
		const el = document.querySelector('.list-item-wrapper.-selected[data-folder-id]');
		return el ? el.getAttribute('data-folder-id') ?? '' : '';
	});
}

/** Click a note in the note list by its title and wait for the editor to catch up. */
export async function selectNoteByTitle(win: Page, title: string): Promise<void> {
	await win.locator('.note-list-item', { hasText: title }).first().click();
	await win.waitForTimeout(SETTLE);
	await expect(win.locator('input.title-input')).toHaveValue(title, { timeout: 20_000 });
}

/** Click a notebook in the sidebar by its exact title. */
export async function selectNotebookByTitle(win: Page, title: string): Promise<void> {
	await win
		.locator(`.list-item-wrapper[data-folder-id] a.list-item:has(.title:text-is("${title}"))`)
		.first()
		.click();
	await win.waitForTimeout(SETTLE);
}

/** Click the sidebar's "All notes" smart filter — the view where Joplin renders its native pill. */
export async function selectAllNotes(win: Page): Promise<void> {
	await win.locator('.list-item-wrapper.all-notes a.list-item').first().click();
	await win.waitForTimeout(SETTLE);
}

/**
 * Expand every collapsed notebook in the sidebar so nested notebooks (Beta under Alpha) become
 * clickable — Joplin collapses a parent by default. Collapsed rows are found by the caret icon
 * rather than by a label, so this does not depend on the UI language.
 */
export async function expandAllNotebooks(win: Page): Promise<void> {
	for (let pass = 0; pass < 4; pass++) {
		const collapsed = win.locator('.sidebar-expand-link:has(.fa-caret-right)');
		const count = await collapsed.count();
		if (!count) break;
		for (let i = 0; i < count; i++) {
			await collapsed.first().click().catch(() => {});
			await win.waitForTimeout(250);
		}
	}
	await win.waitForTimeout(SETTLE);
}

/** Which panes the note editor is currently showing, read off Joplin's own layout classes. */
export async function paneLayout(win: Page): Promise<{ editor: boolean; viewer: boolean; found: boolean }> {
	return win.evaluate(() => {
		// Joplin toggles these two classes on the row holding BOTH panes. `div.editor` inside it is
		// rendered unconditionally, which is exactly why the content script survives viewer-only mode.
		const row = document.querySelector('.note-editor-wrapper .note-editor-viewer-row');
		if (!row) return { editor: false, viewer: false, found: false };
		return {
			editor: row.classList.contains('-show-editor'),
			viewer: row.classList.contains('-show-viewer'),
			found: true,
		};
	});
}

/**
 * Make the rendered viewer the ONLY visible pane.
 *
 * Driven by the note toolbar's "Toggle editor layout" button rather than its Ctrl+L accelerator: the
 * accelerator depends on the keymap and on which element holds focus, and proved unreliable under
 * Xvfb. The button is core's own `toggleVisiblePanes`, found by its icon class so this does not
 * depend on the UI language. The layout cycles both -> editor-only -> viewer-only -> both.
 *
 * Whereabouts must survive this: its content script rides the CodeMirror component, which stays
 * mounted (as a hidden `div.editor`) when only the viewer is shown.
 */
export async function switchToViewerOnly(win: Page): Promise<void> {
	const toggle = win.locator('.note-title-info-group .editor-toolbar button.toolbar-button:has(.icon-layout)');
	await expect(toggle).toBeAttached({ timeout: 30_000 });

	for (let attempt = 0; attempt < 5; attempt++) {
		const layout = await paneLayout(win);
		if (layout.found && !layout.editor && layout.viewer) return;
		await toggle.first().click();
		await win.waitForTimeout(SETTLE);
	}
	const layout = await paneLayout(win);
	throw new Error(
		`Could not reach a viewer-only layout; last seen ${JSON.stringify(layout)}`,
	);
}

/** Return the layout to the default editor+viewer split. */
export async function restoreSplitLayout(win: Page): Promise<void> {
	const toggle = win.locator('.note-title-info-group .editor-toolbar button.toolbar-button:has(.icon-layout)');
	for (let attempt = 0; attempt < 5; attempt++) {
		const layout = await paneLayout(win);
		if (layout.found && layout.editor && layout.viewer) return;
		await toggle.first().click();
		await win.waitForTimeout(SETTLE);
	}
}

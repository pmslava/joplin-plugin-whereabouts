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

// Each of these waits on an ASSERTION about the resulting state rather than on a fixed delay, so the
// suite neither flakes on a slow machine nor pays a fixed toll on a fast one.

/** Click a note in the note list by its title and wait for the editor to catch up. */
export async function selectNoteByTitle(win: Page, title: string): Promise<void> {
	await win.locator('.note-list-item', { hasText: title }).first().click();
	await expect(win.locator('input.title-input')).toHaveValue(title, { timeout: 20_000 });
}

/** Click a notebook in the sidebar by its exact title, and wait for it to become the selection. */
export async function selectNotebookByTitle(win: Page, title: string): Promise<void> {
	await win
		.locator(`.list-item-wrapper[data-folder-id] a.list-item:has(.title:text-is("${title}"))`)
		.first()
		.click();
	await expect(
		win.locator(`.list-item-wrapper.-selected[data-folder-id] a.list-item .title:text-is("${title}")`),
	).toHaveCount(1, { timeout: 20_000 });
}

/** Click the sidebar's "All notes" smart filter — the view where Joplin renders its native pill. */
export async function selectAllNotes(win: Page): Promise<void> {
	await win.locator('.list-item-wrapper.all-notes a.list-item').first().click();
	await expect(win.locator('.list-item-wrapper.all-notes.-selected')).toHaveCount(1, { timeout: 20_000 });
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

// ── multi-window ────────────────────────────────────────────────────────────────────────────────
//
// Every helper above takes the Page it should look in, and its `evaluate` body therefore runs
// against THAT window's document. Pass a secondary window's Page and the assertions describe the
// secondary window. The only ones that are main-window-only by nature are the sidebar helpers:
// a secondary editor window has no sidebar.

/**
 * Open the currently selected note in a secondary window (core's `openNoteInNewWindow`, bound to
 * Ctrl+Alt+N). Returns once Joplin has spawned the window; the caller resolves the Page.
 */
export async function openNoteInNewWindow(win: Page): Promise<void> {
	// Focus must be INSIDE the editor before the shortcut: openNoteInNewWindow acts on the focused
	// window's selected note, and pressing the accelerator with focus elsewhere (the sidebar, the
	// note list's empty space) is a no-op. Same sequence Ridgeline's multi-window spec uses.
	await win.locator('.cm-content').first().click().catch(() => {});
	await win.waitForTimeout(300);
	await win.keyboard.press('Control+Alt+n');
	// No assertion here on purpose: the new window is a separate CDP page, so the caller waits for it
	// with findSecondaryWindow(), which polls.
	await win.waitForTimeout(SETTLE);
}

/**
 * The note the note list is currently REVEALING, or '' when the list does not hold focus.
 *
 * This is how a spec tells a REVEAL (double click -> openNote + focusElementNoteList) from a plain
 * FILTER (single click -> openNote only, focus untouched): the command's observable effect, not a
 * timer. Note that core's `focusNote` focuses the LIST CONTAINER, not the row — the row is marked
 * through `aria-activedescendant="list-note-<id>"` (see useFocusNote / NoteList2). Both halves are
 * required: aria-activedescendant is set whenever the list has an active row, focused or not, so
 * without the focus check this would report a reveal that never happened.
 */
export async function revealedNoteListId(win: Page): Promise<string> {
	return win.evaluate(() => {
		const list = document.querySelector('#notes-list, .note-list') as HTMLElement | null;
		if (!list) return '';
		const active = document.activeElement;
		if (active !== list && !(active && list.contains(active))) return '';
		const descendant = list.getAttribute('aria-activedescendant') ?? '';
		const prefix = 'list-note-';
		return descendant.startsWith(prefix) ? descendant.slice(prefix.length) : '';
	});
}

/** Move DOM focus somewhere harmless so a focus assertion cannot pass by accident. */
export async function blurToTitleInput(win: Page): Promise<void> {
	await win.locator('input.title-input').first().click();
	await win.waitForTimeout(200);
}

/**
 * True while Joplin's "Move to notebook" prompt is on screen.
 *
 * Joplin's Dialog component creates a real <dialog> element imperatively and opens it with
 * showModal(), tagging it with the caller's class ("prompt-dialog" for PromptDialog). Test both the
 * open flag and the class: a modal <dialog> blocks every other interaction in the window, so a spec
 * that fails to notice one would leave it open and poison every test after it.
 */
export async function folderPickerOpen(win: Page): Promise<boolean> {
	return win.evaluate(() =>
		Array.from(document.querySelectorAll('dialog')).some(
			(d) => (d as HTMLDialogElement).open && /prompt-dialog/.test(d.className),
		),
	);
}

/** Classes of every open <dialog>, so a missed-modal failure says what WAS on screen. */
export async function openDialogClasses(win: Page): Promise<string[]> {
	return win.evaluate(() =>
		Array.from(document.querySelectorAll('dialog'))
			.filter((d) => (d as HTMLDialogElement).open)
			.map((d) => d.className || '(no class)'),
	);
}

/**
 * Make sure no modal is left open. A modal <dialog> swallows every click in the window, so one
 * leaked by a failing assertion would cascade into unrelated failures in later tests.
 */
export async function closeAnyOpenDialog(win: Page): Promise<void> {
	if (!(await openDialogClasses(win)).length) return;
	await win.keyboard.press('Escape').catch(() => {});
	await win.waitForTimeout(SETTLE);
	await win
		.evaluate(() => {
			for (const d of Array.from(document.querySelectorAll('dialog'))) {
				const el = d as HTMLDialogElement;
				if (el.open) el.close();
			}
		})
		.catch(() => {});
	await win.waitForTimeout(300);
}

// ── settings screen ─────────────────────────────────────────────────────────────────────────────
//
// There is no Data API route for settings (the route table is ping/notes/folders/tags/resources/
// master_keys/search/services/auth/events/revisions/mcp), so a runtime settings change has to go
// through the real Options screen — which is the more honest test anyway: it also proves the
// settings register with the labels and control types the plugin declares.

/** Open Tools -> Options and select the Whereabouts section. */
export async function openWhereaboutsSettings(win: Page): Promise<void> {
	await win.keyboard.press('Control+,');
	await expect(win.locator('.config-screen')).toBeVisible({ timeout: 30_000 });
	// The section tab id is stable: `setting-tab-${section.name}`.
	await win.locator('#setting-tab-whereabouts\\.settings').click();
	await win.waitForTimeout(SETTLE);
}

/**
 * Apply the pending settings changes and leave the config screen. "Apply" keeps the screen open;
 * "Back" returns to the note editor. Both are plain buttons in the config screen's button bar.
 */
export async function applyAndCloseSettings(win: Page): Promise<void> {
	const apply = win.locator('.button-bar button', { hasText: 'Apply' });
	if (await apply.count()) await apply.first().click();
	await win.waitForTimeout(SETTLE);
	await win.locator('.button-bar button', { hasText: 'Back' }).first().click();
	await win.waitForTimeout(SETTLE);
	await expect(win.locator('.config-screen')).toHaveCount(0, { timeout: 30_000 });
}

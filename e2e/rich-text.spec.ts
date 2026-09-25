import { test, expect, type Page } from '@playwright/test';
import { closeJoplin, launchJoplin, waitForPluginStarted, type JoplinInstance } from './launch';
import {
	connectDataApi,
	seedNotebooks,
	NOTE_IN_BETA_TITLE,
	NOTE_IN_GAMMA_TITLE,
	type DataApi,
	type SeedData,
} from './dataApi';
import {
	CHIP_HOST,
	SETTLE,
	expandAllNotebooks,
	selectAllNotes,
	selectNoteByTitle,
	selectNotebookByTitle,
} from './helpers';

/** TinyMCE renders the note body into an iframe; its presence is what "Rich Text is up" means. */
const TINYMCE_IFRAME = 'iframe.tox-edit-area__iframe';

/**
 * How long to let an event play out before looking at focus. Long enough for Joplin's 300 ms save
 * debounce (AsyncActionQueue(300)), the save itself, the event's delivery to the plugin process and
 * whatever the plugin does in answer, with room to spare on a busy machine. Measured on the broken
 * build, focus had left the title about 400 ms after the last keystroke.
 */
const EVENT_SETTLE_MS = 2500;

const SUFFIX = ' (edited)';

/**
 * Wait until the Rich Text editor is showing `bodyText`. Asserting that no CodeMirror exists as well
 * keeps the spec honest: if the seeded `editor.codeView: false` were ever ignored, every check below
 * would pass trivially against the Markdown editor.
 */
async function waitForRichTextEditor(win: Page, bodyText: string): Promise<void> {
	await expect(win.locator(TINYMCE_IFRAME)).toBeAttached({ timeout: 60_000 });
	await expect(win.frameLocator(TINYMCE_IFRAME).locator('body')).toContainText(bodyText, {
		timeout: 30_000,
	});
	await expect(win.locator('.cm-editor')).toHaveCount(0);
}

/**
 * Where DOM focus is, in words a failure message can be read by. Focus inside TinyMCE shows up in
 * the main document as its iframe being the active element, so "inside the editor container" is the
 * observable for "the note body took focus".
 */
async function whereIsFocus(win: Page): Promise<string> {
	return win.evaluate(() => {
		const active = document.activeElement as HTMLElement | null;
		if (!active || active === document.body) return 'nowhere (document.body)';
		if (active.matches('input.title-input')) return 'the title input';
		const id = active.id ? `#${active.id}` : '';
		const classes =
			typeof active.className === 'string' && active.className.trim()
				? `.${active.className.trim().split(/\s+/).join('.')}`
				: '';
		const inTinyMce = !!active.closest('.tox-tinymce');
		return `${active.tagName.toLowerCase()}${id}${classes}${
			inTinyMce ? ' — INSIDE the TinyMCE editor container (the note body)' : ''
		}`;
	});
}

/**
 * Issue #1: with the Rich Text editor selected, the caret jumped from the title into the note body
 * about 300 ms after the user stopped typing a title.
 *
 * The chain: a title keystroke schedules a save; the save raises `onNoteChange`; the plugin pinged
 * the editor through `editor.execCommand`; Joplin's TinyMCE component forwards that straight into
 * TinyMCE's own `execCommand`, which focuses the editor for any command it does not treat as an
 * undo-level one BEFORE it finds out the command does not exist. The same ping ran on every note
 * selection, so a click in the note list put focus in the note body too.
 *
 * There is no chip in this mode by design, so there is nothing to wait for on screen: the spec waits
 * for the plugin's own "started" line instead (`waitForPluginStarted`), which is logged after every
 * event handler is registered — otherwise a run where the plugin had not started yet would pass for
 * the wrong reason.
 */
test.describe('Whereabouts — Rich Text editor', () => {
	let joplin: JoplinInstance;
	let seed: SeedData;
	let api: DataApi;

	test.beforeAll(async () => {
		joplin = await launchJoplin({ richText: true });
		await waitForPluginStarted(joplin);
		api = await connectDataApi(joplin.apiToken);
		seed = await seedNotebooks(api);
		await joplin.win.waitForTimeout(SETTLE * 2);
		await expandAllNotebooks(joplin.win);
	});

	test.afterAll(async () => {
		if (joplin) await closeJoplin(joplin);
	});

	test('typing a title keeps the caret in the title after the note saves', async () => {
		const { win } = joplin;
		await selectNotebookByTitle(win, 'Gamma');
		await selectNoteByTitle(win, NOTE_IN_GAMMA_TITLE);
		await waitForRichTextEditor(win, 'Body of the note in Gamma.');
		await expect(win.locator(CHIP_HOST)).toHaveCount(0);

		await win.locator('input.title-input').click();
		await win.keyboard.press('End');
		await win.keyboard.type(SUFFIX, { delay: 80 });
		await win.waitForTimeout(EVENT_SETTLE_MS);

		// The save that raises `onNoteChange` really happened inside the window — without this, a
		// passing run could just mean the event had not fired yet.
		const saved = await api.get<{ title: string }>(`/notes/${seed.noteInGamma.id}?fields=title`);
		expect(saved.title, 'the title edit should have been saved by now').toBe(
			NOTE_IN_GAMMA_TITLE + SUFFIX,
		);

		const titleValue = await win.locator('input.title-input').inputValue();
		expect({
			focus: await whereIsFocus(win),
			titleEndsWithSuffix: titleValue.endsWith(SUFFIX),
		}).toEqual({ focus: 'the title input', titleEndsWithSuffix: true });
	});

	test('selecting another note in the list does not put focus in the note body', async () => {
		const { win } = joplin;
		await selectAllNotes(win);

		// Two selections, and only the SECOND is the one under test. On the broken build the FIRST
		// note a fresh window shows kept focus in the note list (measured) — that selection is what
		// mounts TinyMCE, so the ping apparently arrives before there is a TinyMCE to focus — while
		// every later selection moved focus into the body within ~100 ms. Rows are clicked directly
		// and the wait is on the body text, so this does not depend on whether the previous test
		// renamed "Note in Gamma".
		await win.locator('.note-list-item', { hasText: NOTE_IN_BETA_TITLE }).first().click();
		await waitForRichTextEditor(win, 'Body of the note in Beta.');
		await win.locator('.note-list-item', { hasText: NOTE_IN_GAMMA_TITLE }).first().click();
		await waitForRichTextEditor(win, 'Body of the note in Gamma.');
		await win.waitForTimeout(EVENT_SETTLE_MS);

		expect(await whereIsFocus(win)).not.toContain('INSIDE the TinyMCE editor');
	});
});

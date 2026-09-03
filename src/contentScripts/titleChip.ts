/* eslint-disable no-console */
// Whereabouts editor content script (CodeMirror 6).
//
// WHY A CODEMIRROR CONTENT SCRIPT AT ALL, when nothing here touches the note body:
// Joplin's note TITLE BAR is private React DOM with no plugin API in front of it. Panels dock beside
// the sidebar, toolbar buttons are icon-only command bindings, and `loadChromeCssFile` can only
// style what already exists. A ContentScriptType.CodeMirrorPlugin script, however, is loaded by
// PluginLoader as a plain <script> in the renderer document itself — unsandboxed, same JS realm as
// Joplin's UI — so it can reach the title bar directly. The CodeMirror editor is merely the vehicle
// that gets this code into the window; do not "simplify" this into a panel, it cannot work.
//
// CONSEQUENCES, all deliberate:
//  - Markdown / Split / Viewer-only layouts all work, because Joplin's CM6 component always renders
//    its `div.editor` and only toggles -show-editor / -show-viewer classes, so this script stays
//    mounted in every one of them.
//  - The Rich Text (TinyMCE) editor is a different component with no CodeMirror instance, so no
//    plugin JS runs in the window and no chip appears. That is a known, documented limitation.
//  - Mobile has no CodeMirror-hosted chrome DOM at all; the manifest is desktop-only.

import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type {
	CodeMirrorControl,
	ContentScriptContext,
	MarkdownEditorContentScriptModule,
} from 'api/types';
import {
	CHIP_ATTRIBUTE,
	HIDE_NATIVE_CLASS,
	REFRESH_COMMAND,
	chipLabel,
	emptyState,
	type ChipAction,
	type ChipState,
	type Placement,
} from '../common';

/**
 * How often an editor re-asks the plugin for its state.
 *
 * The plugin PUSHES a fresh state through `editor.execCommand`, but that only ever reaches the
 * FOCUSED window's editor. A secondary editor window, or the main window while a secondary one has
 * focus, would otherwise show a stale notebook forever. The poll is the backstop; it is cheap
 * because applying a state is a no-op unless the serialised state actually changed.
 */
const POLL_MS = 1200;

/**
 * How long a single click waits to see whether a second one is coming. Left click and double click
 * mean different things (filter vs reveal), so the single-click action must not fire first.
 */
const DOUBLE_CLICK_MS = 250;

/** Where in the title area the chip goes, expressed as "put it here" rather than "it is here". */
interface Slot {
	parent: HTMLElement;
	/** The node the chip must sit immediately after; null means "first child of parent". */
	after: Node | null;
}

class TitleChip {
	// The editor may live in a SECONDARY window whose document is not the one this script's globals
	// belong to (PluginLoader appends the <script> to the MAIN window). Everything below is derived
	// from the view, never from the global `document` — otherwise a secondary-window editor would
	// silently build its chip into the wrong document.
	private readonly ownerDoc: Document;
	private readonly ownerWin: Window;
	/** This editor's own note-editor column, so two windows never fight over one title bar. */
	private readonly root: HTMLElement;
	private readonly host: HTMLDivElement;
	private readonly button: HTMLButtonElement;
	private readonly icon: HTMLSpanElement;
	private readonly label: HTMLSpanElement;

	private observer: MutationObserver | null = null;
	private syncScheduled = false;
	private clickTimer: number | null = null;
	private state: ChipState = emptyState();
	private renderedSignature = '';
	private destroyed = false;

	/**
	 * True when this editor is in a secondary window. `openNote`, `focusElementNoteList` and
	 * `moveToFolder` all act on the MAIN window's sidebar and note list, so firing them from a
	 * detached editor window would move something the user cannot see. The chip still shows the
	 * location there; it is just inert.
	 */
	private readonly inSecondaryWindow: boolean;

	public constructor(
		private readonly view: EditorView,
		private readonly onAction: (action: ChipAction, state: ChipState) => void,
	) {
		this.ownerDoc = view.dom.ownerDocument;
		this.ownerWin = this.ownerDoc.defaultView ?? window;
		// `document` here is the main renderer window's document, whatever window this editor is in.
		this.inSecondaryWindow = this.ownerDoc !== document;
		this.root = (view.dom.closest('.note-editor-wrapper') as HTMLElement | null) ?? this.ownerDoc.body;

		this.host = this.ownerDoc.createElement('div');
		this.host.setAttribute(CHIP_ATTRIBUTE, '1');
		this.host.className = 'whereabouts-host';

		this.button = this.ownerDoc.createElement('button');
		this.button.type = 'button';

		this.icon = this.ownerDoc.createElement('span');
		this.icon.setAttribute('aria-hidden', 'true');
		this.icon.setAttribute('role', 'img');

		this.label = this.ownerDoc.createElement('span');
		this.label.className = 'whereabouts-label';

		this.button.appendChild(this.icon);
		this.button.appendChild(this.label);
		this.host.appendChild(this.button);

		this.attachHandlers();
		this.observe();
	}

	// ── events ────────────────────────────────────────────────────────────────────────────────────
	//
	// Joplin's global eventHandlerOverrides calls preventDefault() on document clicks whose target is
	// not an INPUT or LABEL, but it does NOT stop propagation — listeners bound directly on our own
	// element still run. So bind here rather than trying to delegate from the document.
	private attachHandlers(): void {
		this.button.addEventListener('click', (event: MouseEvent) => {
			event.preventDefault();
			if (!this.canAct()) return;
			// Defer: a double click also emits two `click` events, and reveal must win over filter.
			if (this.clickTimer !== null) this.ownerWin.clearTimeout(this.clickTimer);
			this.clickTimer = this.ownerWin.setTimeout(() => {
				this.clickTimer = null;
				this.onAction('filter', this.state);
			}, DOUBLE_CLICK_MS);
		});

		this.button.addEventListener('dblclick', (event: MouseEvent) => {
			event.preventDefault();
			if (this.clickTimer !== null) {
				this.ownerWin.clearTimeout(this.clickTimer);
				this.clickTimer = null;
			}
			if (!this.canAct()) return;
			this.onAction('reveal', this.state);
		});

		this.button.addEventListener('contextmenu', (event: MouseEvent) => {
			// Without this the app's own context menu opens on top of the folder picker.
			event.preventDefault();
			if (!this.canAct()) return;
			this.onAction('move', this.state);
		});
	}

	private canAct(): boolean {
		return this.state.actionable && !!this.state.noteId && !this.inSecondaryWindow;
	}

	// ── placement ─────────────────────────────────────────────────────────────────────────────────

	private titleWrapper(): HTMLElement | null {
		return this.root.querySelector('.note-title-wrapper');
	}

	/**
	 * Resolve where the chip belongs for the current placement setting.
	 *
	 * Only the slots below are safe against React re-rendering the title bar (which it does on every
	 * note switch and when the 800px breakpoint flips the wrapper between row and column):
	 *  - a DIRECT child of `.note-title-wrapper`,
	 *  - a DIRECT child of `.editor-toolbar`,
	 *  - the immediate next sibling of `.note-title-wrapper` (the exact slot Joplin's own
	 *    "In: <Notebook>" pill occupies).
	 * Putting it inside a toolbar `.group` is NOT safe: React owns that list and reorders it.
	 */
	private resolveSlot(placement: Placement): Slot | null {
		const wrapper = this.titleWrapper();
		if (!wrapper) return null;

		if (placement === 'inline-right') {
			const input = wrapper.querySelector('input.title-input');
			// Right after the title input, i.e. between the (flex: 1) title and the date + toolbar.
			return { parent: wrapper, after: input ?? null };
		}

		if (placement === 'toolbar-first') {
			// Scope through the info group: `.editor-toolbar` also matches the Markdown formatting
			// toolbar (#CodeMirrorToolbar) further down the editor column.
			const toolbar = wrapper.querySelector('.note-title-info-group .editor-toolbar') as HTMLElement | null;
			if (!toolbar) return null;
			return { parent: toolbar, after: null };
		}

		// below-title
		const parent = wrapper.parentElement;
		if (!parent) return null;
		return { parent, after: wrapper };
	}

	/** True when the chip already sits exactly where `slot` says it should. */
	private isPlaced(slot: Slot): boolean {
		if (this.host.parentElement !== slot.parent) return false;
		return this.host.previousSibling === slot.after;
	}

	private place(): boolean {
		const slot = this.resolveSlot(this.state.settings.placement);
		if (!slot) return false;
		if (this.isPlaced(slot)) return true;
		if (slot.after) {
			(slot.after as ChildNode).after(this.host);
		} else {
			slot.parent.insertBefore(this.host, slot.parent.firstChild);
		}
		return true;
	}

	/**
	 * Watch this editor's column for the React re-renders that would drop or displace the chip: a
	 * note switch rebuilds the title bar, and crossing the 800px viewport breakpoint restacks it.
	 * Without this the chip silently disappears the first time the user resizes the window.
	 */
	private observe(): void {
		const MO = (this.ownerWin as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
		if (typeof MO !== 'function') return;
		this.observer = new MO(() => this.scheduleSync());
		this.observer.observe(this.root, { childList: true, subtree: true });
	}

	// Re-inserting the chip itself fires the observer again, so coalesce and make sync idempotent:
	// a sync that finds nothing to change writes nothing, and the cascade stops after one pass.
	private scheduleSync(): void {
		if (this.destroyed || this.syncScheduled) return;
		this.syncScheduled = true;
		this.ownerWin.setTimeout(() => {
			this.syncScheduled = false;
			if (!this.destroyed) this.sync();
		}, 0);
	}

	// ── rendering ─────────────────────────────────────────────────────────────────────────────────

	public setState(state: ChipState): void {
		this.state = state;
		this.sync();
	}

	private sync(): void {
		if (this.destroyed) return;

		const text = chipLabel(this.state);
		const visible = !!this.state.noteId && text.length > 0;
		if (!visible) {
			this.host.remove();
			this.applyHideNative();
			return;
		}

		const { settings } = this.state;
		const placement = settings.placement;

		// Only rewrite the DOM when something actually changed: this runs from a MutationObserver, and
		// writing unconditionally would keep waking itself up.
		const signature = [text, placement, String(settings.showIcon), String(this.canAct())].join(' ');
		if (signature !== this.renderedSignature) {
			this.renderedSignature = signature;
			this.host.dataset.placement = placement;

			// In the toolbar the chip must BE a native toolbar button, so it inherits Joplin's own
			// sizing, hover and theme colours instead of approximating them.
			const inToolbar = placement === 'toolbar-first';
			this.button.className = inToolbar
				? 'whereabouts-chip button toolbar-button -has-title'
				: 'whereabouts-chip';
			this.icon.className = inToolbar
				? 'whereabouts-icon toolbar-icon -has-title icon-notebooks'
				: 'whereabouts-icon icon-notebooks';
			this.icon.hidden = !settings.showIcon;

			this.label.textContent = text;
			const hint = this.canAct()
				? 'Click to show this notebook, double-click to reveal the note, right-click to move it'
				: '';
			this.button.title = hint ? `In: ${text}\n${hint}` : `In: ${text}`;
			this.button.setAttribute('aria-label', `In: ${text}`);
			this.host.classList.toggle('-inert', !this.canAct());
		}

		this.place();
		this.applyHideNative();
	}

	/**
	 * The native pill's <button> is styled-components-generated and carries no stable class, so the
	 * hide rule in whereabouts.css keys off its notebook ICON class instead. Scope it behind a class
	 * on <html> that we own, so the setting stays live and the rule never fires in a window where no
	 * chip is mounted (Rich Text), where hiding the pill would just lose information.
	 */
	private applyHideNative(): void {
		const on = this.state.settings.hideNativePill && this.host.isConnected;
		this.ownerDoc.documentElement.classList.toggle(HIDE_NATIVE_CLASS, on);
	}

	public destroy(): void {
		this.destroyed = true;
		if (this.clickTimer !== null) this.ownerWin.clearTimeout(this.clickTimer);
		this.clickTimer = null;
		this.observer?.disconnect();
		this.observer = null;
		this.host.remove();
		// Only drop the document-wide hide class once NO chip is left in this document: during an
		// editor remount two instances can briefly overlap, and the survivor must keep its rule.
		if (!this.ownerDoc.querySelector(`[${CHIP_ATTRIBUTE}]`)) {
			this.ownerDoc.documentElement.classList.remove(HIDE_NATIVE_CLASS);
		}
	}
}

export default (context: ContentScriptContext): MarkdownEditorContentScriptModule => ({
	plugin: (editorControl: CodeMirrorControl) => {
		const view = editorControl.editor as EditorView | undefined;
		if (!view) {
			console.warn('[whereabouts] editor control has no CodeMirror 6 view; chip not mounted');
			return;
		}

		let chip: TitleChip | null = new TitleChip(view, (action, state) => {
			void context.postMessage({ type: 'action', action, noteId: state.noteId, folderId: state.folderId });
		});
		let destroyed = false;
		// Answers can arrive out of order (a poll in flight while a note switch fires its own
		// request); only the newest one may win, or the chip flickers back to the previous notebook.
		let requestSeq = 0;
		let appliedSeq = -1;
		let appliedSignature = '';

		const requestState = (): void => {
			if (destroyed) return;
			const seq = ++requestSeq;
			void (async () => {
				let state: ChipState | null = null;
				try {
					state = (await context.postMessage({ type: 'getState' })) as ChipState | null;
				} catch (error) {
					return; // transient; the poll comes round again
				}
				if (destroyed || !chip || !state || seq <= appliedSeq) return;
				appliedSeq = seq;
				const signature = JSON.stringify(state);
				if (signature === appliedSignature) return;
				appliedSignature = signature;
				chip.setState(state);
			})();
		};

		// Live PUSH from the plugin: fires on note selection, note change (which is what a move
		// emits) and settings changes — but only for the FOCUSED window's editor.
		editorControl.registerCommand(REFRESH_COMMAND, (state: ChipState) => {
			if (destroyed || !chip || !state) return;
			appliedSeq = ++requestSeq;
			const signature = JSON.stringify(state);
			if (signature === appliedSignature) return;
			appliedSignature = signature;
			chip.setState(state);
		});

		const timerWin: Window = view.dom.ownerDocument.defaultView ?? window;
		const pollId = timerWin.setInterval(() => {
			if (destroyed || !view.dom.isConnected) return;
			requestState();
		}, POLL_MS);

		// `plugin()` runs ONCE per editor mount, not once per note: switching notes reuses the same
		// CodeMirror instance. Joplin exposes the open note's id as a CM facet (updated through
		// `setNoteIdEffect`), so comparing the facet across an update is the reliable "the note
		// changed" signal — a doc change is not, since editing a note also changes the doc.
		const noteIdFacet = editorControl.joplinExtensions?.noteIdFacet ?? null;
		const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
			if (!noteIdFacet) return;
			if (update.startState.facet(noteIdFacet) !== update.state.facet(noteIdFacet)) requestState();
		});

		const lifecycle = ViewPlugin.fromClass(
			class {
				public destroy() {
					destroyed = true;
					timerWin.clearInterval(pollId);
					chip?.destroy();
					chip = null;
				}
			},
		);

		editorControl.addExtension([updateListener, lifecycle]);

		// First paint.
		requestState();
	},
});

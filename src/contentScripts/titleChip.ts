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
	type ActionResult,
	type ChipAction,
	type ChipState,
	type Placement,
} from '../common';

/**
 * How often an editor re-asks the plugin for its state, and how far it backs off when nothing is
 * happening.
 *
 * Two things make the poll necessary. The plugin's refresh ping travels through
 * `editor.execCommand`, which only ever reaches the FOCUSED window's editor — a secondary editor
 * window, or the main window while a secondary one has focus, would otherwise sit stale. And
 * renaming a notebook fires NO plugin event at all, so re-asking is the only way the chip ever
 * notices a rename.
 *
 * It is kept cheap three ways: the plugin memoises notebook paths, a tick is skipped entirely while
 * the document is hidden, and the interval grows to POLL_IDLE_MS after a run of identical answers
 * (reset the moment anything actually changes). Steady state is therefore one message every few
 * seconds per visible editor, answered from the plugin's cache.
 */
const POLL_MS = 1200;
const POLL_IDLE_MS = 5000;
/** Identical answers in a row before the poll slows to POLL_IDLE_MS. */
const POLL_IDLE_AFTER = 4;

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
	private observedTargets: Node[] = [];
	private syncScheduled = false;
	private clickTimer: number | null = null;
	private state: ChipState = emptyState();
	private renderedSignature = '';
	private destroyed = false;

	/**
	 * True when this editor is in a secondary window (Note -> Open in new window).
	 *
	 * This affects the CLICKS ONLY. The chip itself is fully correct there: the editor sends its own
	 * note id with every state request, so a secondary window names its own notebook regardless of
	 * which window has focus. But `openNote`, `focusElementNoteList` and `moveToFolder` all drive the
	 * MAIN window's sidebar and note list, so firing them from a detached editor would rearrange
	 * something the user is not looking at. The chip stays visible and goes inert.
	 *
	 * `document` is the main window's document even for this editor — Joplin appends the content
	 * script there — which is exactly what makes the comparison a reliable signal.
	 */
	private readonly inSecondaryWindow: boolean;

	/**
	 * Build a chip for this editor, or return null when the editor is not inside a note-editor column
	 * (nothing to attach to). Falling back to the document body was tempting and wrong: the observer
	 * below would then watch the entire document.
	 */
	public static create(
		view: EditorView,
		onAction: (action: ChipAction, state: ChipState) => void,
	): TitleChip | null {
		const root = view.dom.closest('.note-editor-wrapper') as HTMLElement | null;
		if (!root) return null;
		return new TitleChip(view, root, onAction);
	}

	private constructor(
		private readonly view: EditorView,
		root: HTMLElement,
		private readonly onAction: (action: ChipAction, state: ChipState) => void,
	) {
		this.ownerDoc = view.dom.ownerDocument;
		this.ownerWin = this.ownerDoc.defaultView ?? window;
		// `document` here is the main renderer window's document, whatever window this editor is in.
		this.inSecondaryWindow = this.ownerDoc !== document;
		this.root = root;

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
		// The observer is attached in sync(), once the slot for the current placement is known.
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
	 * note switch, and around Joplin mounting/unmounting its own "In: <Notebook>" pill):
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
		if (!slot) {
			// No title bar yet (or it was just torn down). Keep watching the column's title area so we
			// come back when React puts one there.
			this.observe([this.root]);
			return false;
		}
		if (!this.isPlaced(slot)) {
			if (slot.after) {
				(slot.after as ChildNode).after(this.host);
			} else {
				slot.parent.insertBefore(this.host, slot.parent.firstChild);
			}
		}
		// Watch the chain from the chip's own slot up to the title bar's parent. Each link is a node
		// React could replace (info group, toolbar, wrapper) and take our chip down with, and none of
		// them sees editor traffic — so this stays cheap while covering every placement.
		const wrapper = this.titleWrapper();
		this.observe([
			wrapper?.parentElement ?? null,
			wrapper,
			slot.parent.parentElement,
			slot.parent,
		]);
		return true;
	}

	/**
	 * Watch the title area — and ONLY the title area — for the React updates that would drop or
	 * displace the chip.
	 *
	 * What actually threatens the chip: React re-rendering the title bar on a note switch, and
	 * Joplin mounting or unmounting its own "In: <Notebook>" pill as the view changes between a
	 * notebook and a search/tag/All-notes view (that pill is our neighbour in the below-title slot).
	 * The 800px layout change is NOT one of them — `.note-title-wrapper` flips between row and column
	 * through a plain CSS media query (gui/NoteEditor/styles/note-title-wrapper.scss), with no React
	 * involvement and no DOM mutation.
	 *
	 * Scope is the whole point of this method. Watching the editor column with `subtree: true` would
	 * wake this observer on every keystroke and every CodeMirror viewport update, which is a lot of
	 * work to discover nothing changed. Two childList-only observations cover every real case: the
	 * title wrapper's PARENT (the wrapper being replaced, the native pill appearing or disappearing,
	 * and our chip being removed from the below-title slot) and the CURRENT slot's parent (our chip
	 * being removed from inside the wrapper or the toolbar).
	 */
	private observe(targets: Array<Node | null>): void {
		const MO = (this.ownerWin as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
		if (typeof MO !== 'function') return;

		// Dedupe: the slot parent IS the wrapper for inline-right, and its parent for below-title.
		const wanted: Node[] = [];
		for (const target of targets) {
			if (target && wanted.indexOf(target) < 0) wanted.push(target);
		}
		// Re-observing the same nodes on every sync would be pointless churn; skip when unchanged.
		if (
			this.observer &&
			wanted.length === this.observedTargets.length &&
			wanted.every((t, i) => this.observedTargets[i] === t)
		) {
			return;
		}

		this.observer?.disconnect();
		this.observer = new MO(() => this.scheduleSync());
		for (const target of wanted) {
			this.observer.observe(target, { childList: true });
		}
		this.observedTargets = wanted;
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
		const signature = [
			text,
			placement,
			String(settings.showIcon),
			String(this.canAct()),
			this.state.noteId,
			this.state.folderId,
		].join('|');
		if (signature !== this.renderedSignature) {
			this.renderedSignature = signature;
			this.host.dataset.placement = placement;
			// Not used for rendering: these make the chip self-describing for debugging and let the
			// E2E suite assert WHICH note/notebook the chip is currently speaking for.
			this.host.dataset.noteId = this.state.noteId;
			this.host.dataset.folderId = this.state.folderId;

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
		this.observedTargets = [];
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

		let chip: TitleChip | null = TitleChip.create(view, (action, state) => {
			// Report failures rather than swallowing them: openNote throws if the note or its parent
			// notebook has vanished, and moveToFolder throws on an id it cannot load. A dead-feeling
			// button with nothing in the console is the worst of both worlds.
			void context
				.postMessage({ type: 'action', action, noteId: state.noteId, folderId: state.folderId })
				.then((result: ActionResult | null) => {
					if (result && result.ok === false) {
						console.warn(`[whereabouts] action "${action}" did not run: ${result.error ?? 'unknown reason'}`);
					}
				})
				.catch((error: unknown) => {
					console.warn(`[whereabouts] action "${action}" could not be delivered`, error);
				});
		});
		if (!chip) {
			console.warn('[whereabouts] editor is not inside a note-editor column; chip not mounted');
			return;
		}

		let destroyed = false;
		// Answers can arrive out of order (a poll in flight while a note switch fires its own
		// request); only the newest one may win, or the chip flickers back to the previous notebook.
		let requestSeq = 0;
		let appliedSeq = -1;
		let appliedSignature = '';

		// `plugin()` runs ONCE per editor mount, not once per note: switching notes reuses the same
		// CodeMirror instance. Joplin exposes the open note's id as a CM facet (updated through
		// `setNoteIdEffect`), so the facet is both the reliable "the note changed" signal AND — more
		// importantly — the only way this editor can tell the plugin WHICH note it is showing.
		//
		// That matters for correctness, not just efficiency. The plugin's `selectedNote()` reads the
		// root redux state, which Joplin's WINDOW_FOCUS reducer swaps to whichever window has focus,
		// so a secondary editor window that did not send its own id would be told about the focused
		// window's note instead of its own.
		const noteIdFacet = editorControl.joplinExtensions?.noteIdFacet ?? null;
		const currentNoteId = (): string | undefined => {
			if (!noteIdFacet) return undefined;
			const id = view.state.facet(noteIdFacet);
			return typeof id === 'string' && id ? id : undefined;
		};

		// Poll pacing: quick while things are moving, slow once the answer stops changing.
		let pollMs = POLL_MS;
		let unchangedRuns = 0;
		let pollId: number | null = null;

		const applyState = (state: ChipState, seq: number): void => {
			if (destroyed || !chip || seq <= appliedSeq) return;
			appliedSeq = seq;
			const signature = JSON.stringify(state);
			if (signature === appliedSignature) {
				unchangedRuns++;
				return;
			}
			appliedSignature = signature;
			unchangedRuns = 0;
			resetPollPace();
			chip.setState(state);
		};

		const requestState = (): void => {
			if (destroyed) return;
			const seq = ++requestSeq;
			void (async () => {
				let state: ChipState | null = null;
				try {
					state = (await context.postMessage({ type: 'getState', noteId: currentNoteId() })) as ChipState | null;
				} catch (error) {
					return; // transient; the poll comes round again
				}
				if (!state) return;
				applyState(state, seq);
			})();
		};

		const timerWin: Window = view.dom.ownerDocument.defaultView ?? window;
		const ownerDoc: Document = view.dom.ownerDocument;

		// A self-rescheduling timeout rather than setInterval, so the delay can grow and shrink.
		const schedulePoll = (): void => {
			if (destroyed) return;
			pollId = timerWin.setTimeout(() => {
				pollId = null;
				if (destroyed || !view.dom.isConnected) return;
				// A hidden window (minimised, another workspace, the app in the background) cannot be
				// showing a stale chip to anyone. Skip the round-trip entirely and look again later.
				if (ownerDoc.visibilityState === 'visible') {
					if (unchangedRuns >= POLL_IDLE_AFTER) pollMs = POLL_IDLE_MS;
					requestState();
				}
				schedulePoll();
			}, pollMs);
		};

		function resetPollPace(): void {
			unchangedRuns = 0;
			pollMs = POLL_MS;
		}

		// Live refresh PING from the plugin: fires on note selection, note change (which is what a
		// move emits), sync completion and settings changes — but only for the FOCUSED window's
		// editor. It carries no state: only this editor knows which note it holds, so it re-asks.
		editorControl.registerCommand(REFRESH_COMMAND, () => {
			resetPollPace();
			requestState();
		});

		const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
			if (!noteIdFacet) return;
			if (update.startState.facet(noteIdFacet) !== update.state.facet(noteIdFacet)) {
				resetPollPace();
				requestState();
			}
		});

		const lifecycle = ViewPlugin.fromClass(
			class {
				public destroy() {
					destroyed = true;
					if (pollId !== null) timerWin.clearTimeout(pollId);
					pollId = null;
					chip?.destroy();
					chip = null;
				}
			},
		);

		editorControl.addExtension([updateListener, lifecycle]);

		// First paint, then start the poll.
		requestState();
		schedulePoll();
	},
});

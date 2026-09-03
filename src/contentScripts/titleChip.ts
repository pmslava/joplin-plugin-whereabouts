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
	COMPACT_CLASS,
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

		if (placement === 'editor-toolbar') {
			// The EDITOR toolbar — the formatting-button row inside the editor container
			// (`#CodeMirrorToolbar`, aria-label "Editor actions") — not the note toolbar in the title
			// row. Matched by id, because `.editor-toolbar` alone also matches the note toolbar. It is
			// rendered unconditionally by Joplin's CodeMirror component, so it is there in every
			// layout including viewer-only.
			const toolbar = this.root.querySelector('#CodeMirrorToolbar') as HTMLElement | null;
			if (!toolbar) return null;
			// Before the first `.group`, as a DIRECT child. Never inside a `.group`: React owns those
			// lists and reorders them.
			return { parent: toolbar, after: null };
		}

		if (!wrapper) return null;

		if (placement === 'inline-right' || placement === 'below-title-compact') {
			const input = wrapper.querySelector('input.title-input');
			// Both sit right after the title input, as a direct child of the title row. What separates
			// them is pure CSS: below-title-compact adds COMPACT_CLASS to the wrapper, which makes the
			// row wrap so the title takes a full-width line of its own and the chip drops onto a second
			// line with the note-toolbar icons pushed to its right.
			return { parent: wrapper, after: input ?? null };
		}

		// below-title: the slot Joplin's own "In: <Notebook>" pill occupies.
		const parent = wrapper.parentElement;
		if (!parent) return null;
		return { parent, after: wrapper };
	}

	/**
	 * Where the note title's GLYPHS actually end, in viewport coordinates.
	 *
	 * NOT `input.getBoundingClientRect().bottom`. Joplin's title input carries 5px of its own bottom
	 * padding and is 38px tall around a ~23px line box, so its border-box bottom sits roughly 12px
	 * BELOW the last inked pixel of the title. Spacing measured from the box is therefore invisible
	 * to the reader: it looked balanced in the DOM while the eye saw ~11px of air above the chip and
	 * ~4px below it. The rule is about ink, so this is measured in ink.
	 *
	 * Canvas text metrics give the ink extent directly. The baseline is derived the way Chromium lays
	 * a single-line input out: one line box, centred in the content box. `actualBoundingBoxDescent`
	 * is the CURRENT title's ink below that baseline (0 for "Note in Beta", more for a descender), so
	 * the chip tracks the text it is actually sitting under. Returns null when metrics are
	 * unavailable, and the caller falls back to the box edge.
	 */
	private titleInkBottom(input: HTMLInputElement): number | null {
		let ctx: CanvasRenderingContext2D | null = null;
		try {
			ctx = this.ownerDoc.createElement('canvas').getContext('2d');
		} catch (error) {
			return null;
		}
		if (!ctx) return null;

		const cs = this.ownerWin.getComputedStyle(input);
		ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
		const metrics = ctx.measureText(input.value || 'X');
		const ascent = metrics.fontBoundingBoxAscent;
		const descent = metrics.fontBoundingBoxDescent;
		const inkDescent = metrics.actualBoundingBoxDescent;
		const usable = [ascent, descent, inkDescent].every(
			(n) => typeof n === 'number' && Number.isFinite(n),
		);
		if (!usable) return null;

		const rect = input.getBoundingClientRect();
		const borderTop = parseFloat(cs.borderTopWidth) || 0;
		const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
		const padTop = parseFloat(cs.paddingTop) || 0;
		const padBottom = parseFloat(cs.paddingBottom) || 0;
		const contentTop = rect.top + borderTop + padTop;
		const contentHeight = rect.height - borderTop - borderBottom - padTop - padBottom;

		const lineBox = ascent + descent;
		const baseline = contentTop + Math.max(0, (contentHeight - lineBox) / 2) + ascent;
		return baseline + inkDescent;
	}

	/**
	 * Make the chip's row sit on Joplin's own vertical rhythm, and keep its left edge on the column.
	 *
	 * THE RULE (the acceptance criterion, measured in INK — empty pixels the reader actually sees):
	 *     A = chipRow.top       − titleTextInkBottom   (blank space above the chip)
	 *     B = editorToolbar.top − chipRow.bottom       (blank space below the chip)
	 *     A must equal B, and both must equal the blank space a single-line layout leaves between
	 *     the title's glyphs and the toolbar band — so the chip reads as one more line in the same
	 *     grid, not as a banner wedged in with more air above it than below.
	 *
	 * "Ink" is the whole point of the top edge. Measuring from the title INPUT's box bottom looks
	 * balanced in the DOM and is wrong on screen: that box extends ~12px past the last inked pixel
	 * (its own padding plus half-leading), so a box-balanced layout shows the reader far more air
	 * above the chip than below it. See titleInkBottom().
	 *
	 * WHY THIS IS MEASURED RATHER THAN HARD-CODED: the space above the chip is whatever the title
	 * row leaves under the input (the row is `align-items: center`, and the note toolbar beside the
	 * input is a different height), and the space below is whatever the editor container puts above
	 * its toolbar. Both are theme- and layout-dependent. Symmetric padding on the chip cannot fix it
	 * — padding sits INSIDE the host box, so it never touches A or B at all, it just makes the row
	 * taller. What moves A and B is spacing OUTSIDE the box.
	 *
	 * THE ARITHMETIC: let A0 and B0 be the gaps with no correction applied. The single-line gap the
	 * chip has to reproduce on both sides is exactly A0 + B0 — the space that existed before the
	 * chip row was inserted. Adding B0 above and A0 below gives A = A0 + B0 and B = B0 + A0. So the
	 * correction is simply "put the other side's natural gap on this side", it needs no stored
	 * state, it is derived fresh from the current layout every sync, and it converges in one pass.
	 * Nothing is ever negative.
	 *
	 * Below-title spends that on the host's own margins. The compact layout cannot: its host is a
	 * flex item on the wrapper's second line, where `align-items: center` means a margin does not
	 * translate 1:1 into position. It uses the wrapper's `row-gap` (exactly the space between flex
	 * lines) and `padding-bottom` instead — both on `.note-title-wrapper`, which is safe to style
	 * inline for the same reason its marker class is: React renders that element with a constant
	 * className and no style prop, so it never diffs either away.
	 */
	private alignChipRow(): void {
		const placement = this.state.settings.placement;
		const wrapper = this.titleWrapper();
		const ownsRow = placement === 'below-title' || placement === 'below-title-compact';

		if (!ownsRow || !this.host.isConnected) {
			this.clearRowSpacing(wrapper);
			return;
		}
		if (!wrapper) return;

		const toolbar = this.root.querySelector('#CodeMirrorToolbar') as HTMLElement | null;
		const input = wrapper.querySelector('input.title-input') as HTMLElement | null;
		if (!toolbar || !input) return;

		const inputRect = input.getBoundingClientRect();
		const hostRect = this.host.getBoundingClientRect();
		const toolbarRect = toolbar.getBoundingClientRect();
		// Nothing laid out yet (hidden pane, editor still mounting): leave it to the next sync.
		if (toolbarRect.width <= 0 || hostRect.width <= 0 || inputRect.width <= 0) return;

		// ── horizontal: keep the chip's left edge on the toolbar's ──────────────────────────────
		// Only below-title needs this; the compact chip is inside the title row and inherits its
		// padding-left already.
		if (placement === 'below-title') {
			const delta = toolbarRect.left - this.button.getBoundingClientRect().left;
			if (Math.abs(delta) >= 0.5) {
				const current = parseFloat(this.ownerWin.getComputedStyle(this.host).paddingLeft) || 0;
				this.host.style.paddingLeft = `${Math.max(0, current + delta)}px`;
			}
		}

		// ── vertical: A = B = the single-line gap ───────────────────────────────────────────────
		const compact = placement === 'below-title-compact';
		const group = wrapper.querySelector('.note-title-info-group') as HTMLElement | null;
		// In the compact layout the chip shares its row with the date + icons, so the spacing is
		// measured against the wrapped LINE — highest top to lowest bottom — not the chip's own box.
		// The chip is usually the shorter of the two and is centred in the line, so measuring from
		// its own top would mistake that centring offset for empty space above the row.
		const groupRect = compact && group ? group.getBoundingClientRect() : null;
		// The space above is measured to the CHIP's own box — that is the edge the reader sees, and
		// the chip can sit lower than its line's top if something taller shares the line. The space
		// below is measured from whichever of the two reaches lower, so the gap is never overstated.
		const rowTop = hostRect.top;
		const rowBottom = groupRect ? Math.max(hostRect.bottom, groupRect.bottom) : hostRect.bottom;

		const styles = this.ownerWin.getComputedStyle(compact ? wrapper : this.host);
		const appliedAbove = parseFloat(compact ? styles.rowGap : styles.marginTop) || 0;
		const appliedBelow = parseFloat(compact ? styles.paddingBottom : styles.marginBottom) || 0;

		// Ink, not box: see titleInkBottom(). Falling back to the box edge keeps the chip placed
		// (just less precisely) if canvas metrics are ever unavailable.
		const titleBottom = this.titleInkBottom(input as HTMLInputElement) ?? inputRect.bottom;
		const naturalAbove = rowTop - titleBottom - appliedAbove;
		const naturalBelow = toolbarRect.top - rowBottom - appliedBelow;

		// Put the other side's natural gap on this side; both then equal naturalAbove + naturalBelow.
		const nextAbove = Math.max(0, naturalBelow);
		const nextBelow = Math.max(0, naturalAbove);

		if (Math.abs(nextAbove - appliedAbove) >= 0.5) {
			if (compact) wrapper.style.rowGap = `${nextAbove}px`;
			else this.host.style.marginTop = `${nextAbove}px`;
		}
		if (Math.abs(nextBelow - appliedBelow) >= 0.5) {
			if (compact) wrapper.style.paddingBottom = `${nextBelow}px`;
			else this.host.style.marginBottom = `${nextBelow}px`;
		}
	}

	/** Drop every inline correction, so switching placement cannot strand another one's spacing. */
	private clearRowSpacing(wrapper: HTMLElement | null): void {
		const s = this.host.style;
		if (s.paddingLeft) s.paddingLeft = '';
		if (s.marginTop) s.marginTop = '';
		if (s.marginBottom) s.marginBottom = '';
		if (wrapper) {
			if (wrapper.style.rowGap) wrapper.style.rowGap = '';
			if (wrapper.style.paddingBottom) wrapper.style.paddingBottom = '';
		}
	}

	/**
	 * Add or remove the compact-layout marker on `.note-title-wrapper`.
	 *
	 * Re-asserted on every sync (so the MutationObserver restores it after a React re-render) and
	 * cleared whenever the placement is anything else, so switching placements live cannot leave a
	 * stale class rearranging the title row.
	 */
	private applyCompactClass(): void {
		const wrapper = this.titleWrapper();
		if (!wrapper) return;
		const on = this.state.settings.placement === 'below-title-compact' && this.host.isConnected;
		wrapper.classList.toggle(COMPACT_CLASS, on);
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
			this.applyCompactClass();
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

			// In the editor toolbar the chip must BE a native toolbar button, so it inherits Joplin's
			// own sizing, hover and theme colours instead of approximating them. `-has-title` is what
			// tells core's CSS to let the button grow past its icon-only square.
			const inToolbar = placement === 'editor-toolbar';
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
		this.applyCompactClass();
		this.alignChipRow();
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
		// The chip is going away, so the title row must go back to its normal single-line layout.
		const wrapper = this.titleWrapper();
		wrapper?.classList.remove(COMPACT_CLASS);
		this.clearRowSpacing(wrapper);
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

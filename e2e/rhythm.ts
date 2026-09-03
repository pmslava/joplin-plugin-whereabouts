import * as fs from 'fs';
import * as path from 'path';

/**
 * The single-line gap between the note title and the editor toolbar, measured once (in the
 * inline-right launch) and reused by the chip-row placements.
 *
 * It has to cross a process boundary rather than live in a module variable: each placement needs
 * its own Joplin, Playwright may recycle the worker between them, and the value must survive that.
 * It is a property of the theme and window size, so it is identical in every launch of one run.
 */
const FILE = path.resolve(__dirname, '..', 'test-results', 'single-line-gap.json');

export function recordSingleLineGap(gap: number): void {
	fs.mkdirSync(path.dirname(FILE), { recursive: true });
	fs.writeFileSync(FILE, JSON.stringify({ gap }), 'utf8');
}

/** Returns null when the inline-right spec has not run yet in this invocation. */
export function readSingleLineGap(): number | null {
	try {
		const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { gap?: number };
		return typeof raw.gap === 'number' ? raw.gap : null;
	} catch {
		return null;
	}
}

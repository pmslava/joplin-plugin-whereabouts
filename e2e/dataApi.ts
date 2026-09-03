import * as http from 'http';

/**
 * A thin client for Joplin's own Data API (the "Web Clipper" REST service), used ONLY to seed test
 * data.
 *
 * Why not click the GUI, as the note/notebook helpers otherwise do: Whereabouts has to be proven
 * against a NESTED notebook ("Parent / Child"), and the desktop app's only route to a sub-notebook
 * is the `newSubFolder` command, reachable from the File menu or the sidebar's right-click menu —
 * both native Electron menus, which Playwright cannot drive. Sidebar drag-and-drop is the other
 * option and is far flakier than an HTTP POST.
 *
 * SAFETY — this must never touch the developer's real Joplin. Every request carries the random
 * token that the harness seeded into THIS throwaway profile, and port discovery accepts a port only
 * if that token authenticates there. Another Joplin already holding 41184 has a different token and
 * answers 403, so it is skipped rather than written to.
 */

const PORT_SCAN_START = 41184;
const PORT_SCAN_COUNT = 12;

export interface Folder {
	id: string;
	title: string;
	parent_id: string;
}

export interface Note {
	id: string;
	title: string;
	parent_id: string;
}

export class DataApi {
	public constructor(
		public readonly port: number,
		private readonly token: string,
	) {}

	public async get<T>(path: string): Promise<T> {
		return this.request<T>('GET', path);
	}

	public async post<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>('POST', path, body);
	}

	public async put<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>('PUT', path, body);
	}

	private request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const separator = path.includes('?') ? '&' : '?';
		const payload = body === undefined ? undefined : JSON.stringify(body);
		return new Promise<T>((resolve, reject) => {
			const req = http.request(
				{
					host: '127.0.0.1',
					port: this.port,
					method,
					path: `${path}${separator}token=${this.token}`,
					headers: payload
						? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
						: {},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (c: Buffer) => chunks.push(c));
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						if ((res.statusCode ?? 0) >= 400) {
							reject(new Error(`Joplin API ${method} ${path} -> ${res.statusCode}: ${text}`));
							return;
						}
						try {
							resolve(text ? (JSON.parse(text) as T) : (null as unknown as T));
						} catch (error) {
							reject(new Error(`Joplin API ${method} ${path} returned non-JSON: ${text}`));
						}
					});
				},
			);
			req.on('error', reject);
			if (payload) req.write(payload);
			req.end();
		});
	}

	public async createFolder(title: string, parentId = ''): Promise<Folder> {
		return this.post<Folder>('/folders', { title, parent_id: parentId });
	}

	public async createNote(title: string, parentId: string, body = ''): Promise<Note> {
		return this.post<Note>('/notes', { title, parent_id: parentId, body });
	}

	public async renameFolder(id: string, title: string): Promise<Folder> {
		return this.put<Folder>(`/folders/${id}`, { title });
	}

	public async moveNote(id: string, parentId: string): Promise<Note> {
		return this.put<Note>(`/notes/${id}`, { parent_id: parentId });
	}
}

/**
 * Find the port on which THIS Joplin instance is serving its Data API, by trying the token against
 * each candidate. Joplin starts at 41184 and walks upward when the port is taken, so a developer's
 * own running Joplin simply shifts ours by one; it never gets written to, because it rejects our
 * token.
 */
export async function connectDataApi(token: string, timeoutMs = 60_000): Promise<DataApi> {
	const start = Date.now();
	let lastError: unknown = null;
	while (Date.now() - start < timeoutMs) {
		for (let i = 0; i < PORT_SCAN_COUNT; i++) {
			const port = PORT_SCAN_START + i;
			const api = new DataApi(port, token);
			try {
				await api.get('/folders');
				return api;
			} catch (error) {
				lastError = error;
			}
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`Could not reach this instance's Joplin Data API on ports ${PORT_SCAN_START}-${
			PORT_SCAN_START + PORT_SCAN_COUNT - 1
		}. Last error: ${String(lastError)}`,
	);
}

/** The notebooks and notes every spec works with. Alpha > Beta is the nested pair. */
export interface SeedData {
	alpha: Folder;
	beta: Folder;
	gamma: Folder;
	noteInBeta: Note;
	noteInGamma: Note;
}

export const NOTE_IN_BETA_TITLE = 'Note in Beta';
export const NOTE_IN_GAMMA_TITLE = 'Note in Gamma';

export async function seedNotebooks(api: DataApi): Promise<SeedData> {
	const alpha = await api.createFolder('Alpha');
	const beta = await api.createFolder('Beta', alpha.id);
	const gamma = await api.createFolder('Gamma');
	const noteInBeta = await api.createNote(NOTE_IN_BETA_TITLE, beta.id, 'Body of the note in Beta.');
	const noteInGamma = await api.createNote(NOTE_IN_GAMMA_TITLE, gamma.id, 'Body of the note in Gamma.');
	return { alpha, beta, gamma, noteInBeta, noteInGamma };
}

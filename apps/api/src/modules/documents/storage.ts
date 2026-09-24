import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../../config/env';
import { AppError } from '../../lib/errors';

/**
 * Document storage: bytes go in under an opaque key and come out as a stream. Nothing else.
 *
 * A key is generated here (`documents/<2 hex>/<uuid>`), never derived from a title, an employee or a file name, and
 * every key is checked to resolve inside the configured root before the filesystem is touched. There is no static
 * file serving: the only way to a byte is the authenticated download endpoint.
 */
export interface StoredObject { size: number; sha256: string }
export interface DocumentStorage {
  put(key: string, stream: Readable): Promise<StoredObject>;
  getStream(key: string, range?: { start: number; end: number }): Readable;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Liveness: the root exists and is writable, verified with a create/delete of a private probe file. */
  health(): Promise<{ ok: boolean; reason?: string }>;
}

const KEY_PATTERN = /^documents\/[0-9a-f]{2}\/[0-9a-f-]{36}$/;
export const newStorageKey = (): string => { const id = randomUUID(); return `documents/${id.slice(0, 2)}/${id}`; };

export class LocalFileDocumentStorage implements DocumentStorage {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }

  /** The one place a key becomes a path. Rejects anything that is not a generated key or that escapes the root. */
  resolve(key: string): string {
    if (typeof key !== 'string' || key.includes('\0') || key.includes('..') || path.isAbsolute(key) || /%/.test(key) || !KEY_PATTERN.test(key)) {
      throw new AppError(400, 'DOCUMENT_STORAGE_KEY_INVALID', 'Invalid storage key');
    }
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new AppError(400, 'DOCUMENT_STORAGE_KEY_INVALID', 'Invalid storage key');
    return full;
  }

  async put(key: string, stream: Readable): Promise<StoredObject> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.part-${randomUUID()}`;
    const hash = createHash('sha256');
    let size = 0;
    stream.on('data', (chunk: Buffer) => { hash.update(chunk); size += chunk.length; });
    try {
      await pipeline(stream, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      await rename(tmp, full);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    return { size, sha256: hash.digest('hex') };
  }

  getStream(key: string, range?: { start: number; end: number }): Readable { return createReadStream(this.resolve(key), range); }
  async exists(key: string): Promise<boolean> { try { await access(this.resolve(key), constants.R_OK); return true; } catch { return false; } }
  async stat(key: string) { try { const s = await stat(this.resolve(key)); return { size: s.size }; } catch { return null; } }
  async delete(key: string): Promise<void> { await unlink(this.resolve(key)).catch(() => undefined); }

  async health() {
    try {
      await mkdir(this.root, { recursive: true });
      const probe = path.join(this.root, `.health-${randomUUID()}`);
      await pipeline(Readable.from([Buffer.from('ok')]), createWriteStream(probe, { flags: 'wx', mode: 0o600 }));
      await unlink(probe);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

let instance: DocumentStorage | null = null;
/** The configured adapter, or a 503 when the document center is disabled or has nowhere to write. */
export function documentStorage(): DocumentStorage {
  if (!env.DOCUMENTS_ENABLED) throw new AppError(503, 'DOCUMENTS_DISABLED', 'The document center is disabled on this installation');
  if (!instance) {
    const root = env.DOCUMENT_STORAGE_DIR ?? (env.isProduction ? null : path.resolve(process.cwd(), env.isTest ? '.data/documents-test' : '.data/documents'));
    if (!root) throw new AppError(503, 'DOCUMENTS_NOT_CONFIGURED', 'DOCUMENT_STORAGE_DIR is not configured');
    instance = new LocalFileDocumentStorage(root);
  }
  return instance;
}
export const documentStorageConfigured = () => env.DOCUMENTS_ENABLED && (!!env.DOCUMENT_STORAGE_DIR || !env.isProduction);

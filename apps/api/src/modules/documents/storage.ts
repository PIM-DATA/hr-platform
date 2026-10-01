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
  /**
   * Readiness of the store (Task 49, T44-P1-10 / P2-19). `hasDocuments` says whether the database references any stored
   * object. The root is never re-created behind the operator's back once documents exist: a missing or empty root then
   * means an unmounted volume or a database restored without its files, and is reported, not papered over.
   */
  health(hasDocuments: boolean): Promise<{ ok: boolean; reason?: StorageHealthReason }>;
}
/** Stable, path-free reason codes (safe for the readiness payload and logs). */
export type StorageHealthReason = 'ROOT_MISSING' | 'ROOT_NOT_DIRECTORY' | 'ROOT_EMPTY_BUT_DOCUMENTS_EXIST' | 'NOT_READABLE' | 'NOT_WRITABLE';

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
    // The root itself must already exist (created at install, or by a readiness check on an empty installation): a
    // write must never silently re-create a missing volume mount point.
    const root = await stat(this.root).catch(() => null);
    if (!root?.isDirectory()) throw new AppError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage is not available');
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

  async health(hasDocuments: boolean): Promise<{ ok: boolean; reason?: StorageHealthReason }> {
    const root = await stat(this.root).catch(() => null);
    if (!root) {
      // A brand-new installation (nothing stored yet) may create its root; an installation with documents may not.
      if (hasDocuments) return { ok: false, reason: 'ROOT_MISSING' };
      try { await mkdir(this.root, { recursive: true, mode: 0o700 }); } catch { return { ok: false, reason: 'NOT_WRITABLE' }; }
    } else if (!root.isDirectory()) {
      return { ok: false, reason: 'ROOT_NOT_DIRECTORY' };
    }
    try { await access(this.root, constants.R_OK | constants.X_OK); } catch { return { ok: false, reason: 'NOT_READABLE' }; }
    // Objects live under <root>/documents/; documents in the database but no object directory = wrong or empty volume.
    if (hasDocuments && !(await stat(path.join(this.root, 'documents')).catch(() => null))?.isDirectory()) return { ok: false, reason: 'ROOT_EMPTY_BUT_DOCUMENTS_EXIST' };
    try {
      const probe = path.join(this.root, `.health-${randomUUID()}`);
      await pipeline(Readable.from([Buffer.from('ok')]), createWriteStream(probe, { flags: 'wx', mode: 0o600 }));
      await unlink(probe);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'NOT_WRITABLE' };
    }
  }
}

let instance: DocumentStorage | null = null;
/** The configured adapter, or a 503 when the document center is disabled or has nowhere to write. */
export function documentStorage(): DocumentStorage {
  if (!env.DOCUMENTS_ENABLED) throw new AppError(503, 'DOCUMENTS_DISABLED', 'The document center is disabled on this installation');
  if (!instance) {
    const root = documentStorageRoot();
    if (!root) throw new AppError(503, 'DOCUMENTS_NOT_CONFIGURED', 'DOCUMENT_STORAGE_DIR is not configured');
    instance = new LocalFileDocumentStorage(root);
  }
  return instance;
}
export const documentStorageConfigured = () => env.DOCUMENTS_ENABLED && (!!env.DOCUMENT_STORAGE_DIR || !env.isProduction);

/** The configured local root (for operational tooling: backup, restore, integrity), or null when not configured. */
export function documentStorageRoot(source: { DOCUMENTS_ENABLED: boolean; DOCUMENT_STORAGE_DIR?: string; isProduction: boolean; isTest: boolean } = env, cwd = process.cwd()): string | null {
  if (!source.DOCUMENTS_ENABLED) return null;
  if (source.DOCUMENT_STORAGE_DIR) return path.resolve(source.DOCUMENT_STORAGE_DIR);
  return source.isProduction ? null : path.resolve(cwd, source.isTest ? '.data/documents-test' : '.data/documents');
}

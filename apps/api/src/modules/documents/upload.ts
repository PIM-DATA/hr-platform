import busboy from 'busboy';
import type { NextFunction, Request, Response } from 'express';
import { PassThrough } from 'node:stream';
import { DOCUMENT_ALLOWED_EXTENSIONS, DOCUMENT_BLOCKED_EXTENSIONS, DOCUMENT_FILE_TYPES, fileExtension, matchesSignature, sanitizeFilename } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { env } from '../../config/env';
import { documentStorage, newStorageKey } from './storage';

/**
 * Streaming document upload: the file goes straight from the request into the storage adapter under a fresh key,
 * hashed on the way, with the size limit enforced while streaming and the first bytes checked against the
 * signature the extension promises. Nothing is buffered whole and nothing is written under a name the client chose.
 * The stored object is handed to the route on `req.documentUpload`; if the route then fails, it deletes it.
 */
export interface DocumentUpload { storageKey: string; originalFilename: string; extension: string; mimeType: string; fileSize: number; sha256: string; fields: Record<string, string> }
declare module 'express-serve-static-core' { interface Request { documentUpload?: DocumentUpload } }

export const platformMaxBytes = () => env.DOCUMENT_MAX_FILE_MB * 1024 * 1024;

export function documentUpload(options: { maxBytes?: number; allowedExtensions?: string[] } = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.is('multipart/form-data')) return next(new AppError(400, 'UPLOAD_NOT_MULTIPART', 'Send the file as multipart/form-data'));
    const maxBytes = options.maxBytes ?? platformMaxBytes();
    const allowed = options.allowedExtensions ?? DOCUMENT_ALLOWED_EXTENSIONS;
    const storage = documentStorage();
    const bb = busboy({ headers: req.headers, limits: { files: 1, fields: 20, fieldSize: 4096, fileSize: maxBytes, parts: 25 } });
    const fields: Record<string, string> = {};
    let settled = false;
    let pending: Promise<void> | null = null;
    let upload: DocumentUpload | null = null;
    const fail = (error: AppError) => { if (settled) return; settled = true; req.unpipe(bb); next(error); };

    bb.on('field', (name, value) => { if (Object.keys(fields).length < 20) fields[name] = String(value).slice(0, 4096); });
    bb.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return; }
      const originalFilename = sanitizeFilename(info.filename ?? '');
      const extension = fileExtension(originalFilename);
      const spec = DOCUMENT_FILE_TYPES[extension];
      if (DOCUMENT_BLOCKED_EXTENSIONS.includes(extension) || !spec || !allowed.includes(extension)) { stream.resume(); return fail(new AppError(415, 'DOCUMENT_TYPE_NOT_ALLOWED', `Files of type "${extension || 'unknown'}" are not accepted. Allowed: ${allowed.join(', ')}`)); }
      const mimeType = (info.mimeType ?? '').toLowerCase();
      if (mimeType && mimeType !== 'application/octet-stream' && !spec.mimes.includes(mimeType)) { stream.resume(); return fail(new AppError(415, 'DOCUMENT_TYPE_MISMATCH', `The declared type ${mimeType} does not match a ${extension} file`)); }

      // Sniff the head before committing bytes: a renamed executable or an HTML page fails here.
      const head: Buffer[] = []; let headLen = 0; let sniffed = false; let bad: AppError | null = null;
      const through = new PassThrough();
      stream.on('data', (chunk: Buffer) => {
        if (!sniffed) { head.push(chunk); headLen += chunk.length; if (headLen >= 8192) { sniffed = true; if (!matchesSignature(spec.signature, Buffer.concat(head).subarray(0, 8192))) bad = new AppError(415, 'DOCUMENT_CONTENT_MISMATCH', `The file content does not look like a ${extension} file`); } }
        through.write(chunk);
      });
      stream.on('limit', () => { bad = new AppError(413, 'DOCUMENT_TOO_LARGE', `The file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`); through.end(); });
      stream.on('end', () => { if (!sniffed) { sniffed = true; if (!matchesSignature(spec.signature, Buffer.concat(head))) bad = bad ?? new AppError(415, 'DOCUMENT_CONTENT_MISMATCH', `The file content does not look like a ${extension} file`); } through.end(); });
      const key = newStorageKey();
      pending = storage.put(key, through).then(async (stored) => {
        if (bad || stored.size === 0) { await storage.delete(key); throw bad ?? new AppError(400, 'DOCUMENT_EMPTY', 'The file is empty'); }
        upload = { storageKey: key, originalFilename, extension, mimeType: spec.mimes[0]!, fileSize: stored.size, sha256: stored.sha256, fields };
      });
      pending.catch(() => undefined);
    });
    bb.on('filesLimit', () => fail(new AppError(400, 'UPLOAD_TOO_MANY_FILES', 'Send exactly one file')));
    bb.on('error', () => fail(new AppError(400, 'UPLOAD_INVALID', 'The upload could not be read')));
    bb.on('close', () => {
      if (settled) return;
      settled = true;
      if (!pending) return next(new AppError(400, 'UPLOAD_FILE_REQUIRED', 'A file is required'));
      pending.then(() => { if (!upload) return next(new AppError(400, 'UPLOAD_FILE_REQUIRED', 'A file is required')); upload.fields = fields; req.documentUpload = upload; next(); }).catch((e) => next(e instanceof AppError ? e : new AppError(500, 'DOCUMENT_STORE_FAILED', 'The file could not be stored')));
    });
    req.pipe(bb);
  };
}

import busboy from 'busboy';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';

/**
 * Minimal bounded multipart reader for the single workbook upload.
 *
 * The file is held in memory and handed to the parser; nothing is ever written to disk, because the workbook is full
 * of personal data and keeping a copy would duplicate that data outside the database (the imported records are the
 * real record). Limits are enforced while streaming, so an oversized upload is cut off rather than buffered whole.
 *
 * `Content-Type` alone is never trusted: the extension is checked here and the parser then has to read the file as a
 * real .xlsx workbook with the expected sheets — a renamed binary fails there.
 */
export interface UploadedFile {
  fieldName: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}
declare module 'express-serve-static-core' {
  interface Request {
    uploadedFile?: UploadedFile;
    uploadedFields?: Record<string, string>;
  }
}

const XLSX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream', // some browsers/proxies send this; the parser is the real check
  'application/zip',
]);

export function singleFileUpload(options: { maxBytes: number; field?: string; extensions?: string[] }) {
  const field = options.field ?? 'file';
  const extensions = options.extensions ?? ['.xlsx'];

  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.is('multipart/form-data')) return next(new AppError(400, 'UPLOAD_NOT_MULTIPART', 'Send the workbook as multipart/form-data'));

    const bb = busboy({
      headers: req.headers,
      limits: { files: 1, fields: 10, fieldSize: 1024, fileSize: options.maxBytes, parts: 12 },
    });
    const fields: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let settled = false;
    let fileInfo: { fileName: string; mimeType: string } | null = null;
    const fail = (error: AppError) => {
      if (settled) return;
      settled = true;
      req.unpipe(bb);
      next(error);
    };

    bb.on('field', (name, value) => { if (Object.keys(fields).length < 10) fields[name] = String(value).slice(0, 1024); });
    bb.on('file', (name, stream, info) => {
      if (name !== field) { stream.resume(); return; }
      const fileName = info.filename ?? '';
      if (!extensions.some((ext) => fileName.toLowerCase().endsWith(ext))) {
        stream.resume();
        return fail(new AppError(400, 'ONBOARDING_UNSUPPORTED_FILE_TYPE', `Only ${extensions.join(', ')} files are accepted`));
      }
      if (info.mimeType && !XLSX_MIME.has(info.mimeType)) {
        stream.resume();
        return fail(new AppError(400, 'ONBOARDING_UNSUPPORTED_FILE_TYPE', 'The file does not look like an Excel workbook'));
      }
      fileInfo = { fileName, mimeType: info.mimeType ?? '' };
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => fail(new AppError(413, 'ONBOARDING_FILE_TOO_LARGE', `The workbook exceeds the ${Math.round(options.maxBytes / 1024 / 1024)} MB limit`)));
    });
    bb.on('filesLimit', () => fail(new AppError(400, 'UPLOAD_TOO_MANY_FILES', 'Send exactly one file')));
    bb.on('error', () => fail(new AppError(400, 'UPLOAD_INVALID', 'The upload could not be read')));
    bb.on('close', () => {
      if (settled) return;
      settled = true;
      if (!fileInfo || !chunks.length) return next(new AppError(400, 'UPLOAD_FILE_REQUIRED', 'A workbook file is required'));
      req.uploadedFile = { fieldName: field, fileName: fileInfo.fileName, mimeType: fileInfo.mimeType, buffer: Buffer.concat(chunks) };
      req.uploadedFields = fields;
      next();
    });

    req.pipe(bb);
  };
}

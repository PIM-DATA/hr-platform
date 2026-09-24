import type { DocumentExpiryState } from './enums';

/**
 * Pure document rules (Task 30). File types, names and expiry — nothing that touches a filesystem.
 */

/** Extension → accepted declared MIME types. The signature check is the real gate; MIME must merely not contradict. */
export const DOCUMENT_FILE_TYPES: Record<string, { mimes: string[]; inline: boolean; signature: 'PDF' | 'PNG' | 'JPEG' | 'ZIP' | 'TEXT' }> = {
  '.pdf': { mimes: ['application/pdf'], inline: true, signature: 'PDF' },
  '.docx': { mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'], inline: false, signature: 'ZIP' },
  '.xlsx': { mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'], inline: false, signature: 'ZIP' },
  '.png': { mimes: ['image/png'], inline: true, signature: 'PNG' },
  '.jpg': { mimes: ['image/jpeg'], inline: true, signature: 'JPEG' },
  '.jpeg': { mimes: ['image/jpeg'], inline: true, signature: 'JPEG' },
  '.txt': { mimes: ['text/plain'], inline: true, signature: 'TEXT' },
  '.csv': { mimes: ['text/csv', 'text/plain', 'application/vnd.ms-excel'], inline: false, signature: 'TEXT' },
};
export const DOCUMENT_ALLOWED_EXTENSIONS = Object.keys(DOCUMENT_FILE_TYPES);
/** Never accepted, whatever the declared type: anything a browser or shell would execute. */
export const DOCUMENT_BLOCKED_EXTENSIONS = ['.exe', '.dll', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.sh', '.bash', '.zsh', '.js', '.mjs', '.cjs', '.ts', '.jar', '.vbs', '.wsf', '.html', '.htm', '.xhtml', '.svg', '.xml', '.php', '.py', '.rb', '.pl', '.apk', '.app', '.dmg'];

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot).toLowerCase();
}

/** The stored display name: no path, no control characters, bounded. Never used as a filesystem path. */
export function sanitizeFilename(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim();
  return (cleaned || 'document').slice(0, 200);
}

/** Does the first chunk of the file carry the signature the extension promises? */
export function matchesSignature(kind: 'PDF' | 'PNG' | 'JPEG' | 'ZIP' | 'TEXT', head: Uint8Array): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  switch (kind) {
    case 'PDF': return starts(0x25, 0x50, 0x44, 0x46); // %PDF
    case 'PNG': return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'JPEG': return starts(0xff, 0xd8, 0xff);
    case 'ZIP': return starts(0x50, 0x4b, 0x03, 0x04); // PK..
    case 'TEXT': {
      if (head.length === 0) return true;
      for (let i = 0; i < head.length; i++) if (head[i] === 0) return false; // NUL: binary, not text
      const text = new TextDecoder('utf-8', { fatal: false }).decode(head).trimStart().toLowerCase();
      return !/^(<!doctype|<html|<script|<svg|<\?xml)/.test(text) && !/<script[\s>]/.test(text);
    }
  }
}

export const DOCUMENT_EXPIRY_SOON_DAYS = 30;
export function expiryState(expiryDate: string | null | undefined, today: string): DocumentExpiryState {
  if (!expiryDate) return 'NONE';
  if (expiryDate < today) return 'EXPIRED';
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + DOCUMENT_EXPIRY_SOON_DAYS);
  return expiryDate <= soon.toISOString().slice(0, 10) ? 'EXPIRING_SOON' : 'VALID';
}

export const formatDocumentNumber = (year: number, sequence: number) => `DOC-${year}-${String(sequence).padStart(6, '0')}`;

/** RFC 5987 filename for Content-Disposition: ASCII fallback plus UTF-8 form. */
export function contentDispositionFilename(name: string): string {
  const safe = sanitizeFilename(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

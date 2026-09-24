import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, contentDispositionFilename, createDocumentCategorySchema, createDocumentSchema, documentListQuerySchema, linkDocumentSchema, updateDocumentCategorySchema, updateDocumentSchema, uploadVersionSchema } from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { AppError } from '../../lib/errors';
import { documentCategoryService, documentService } from './documents.service';
import { documentStorage } from './storage';
import { documentUpload } from './upload';

/**
 * Document center (Task 30). Bytes enter through `documentUpload` (streamed into storage under an opaque key) and
 * leave through `/download`, after the full authorization; there is no static URL to a file. Metadata endpoints
 * follow the same rule: outside the caller's authorization a document does not exist.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const viewAny = requirePermission(PERMISSIONS.DOCUMENTS_VIEW_OWN, PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.DOCUMENTS_MANAGE);
const view = requirePermission(PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.DOCUMENTS_MANAGE);
const manage = requirePermission(PERMISSIONS.DOCUMENTS_MANAGE);
/** Multipart fields arrive as strings; empty ones mean "not given". */
const parseFields = <T>(schema: z.ZodType<T>, fields: Record<string, string>): T => {
  const cleaned = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', parsed.error.issues.map((i) => ({ field: i.path.join('.') || undefined, message: i.message })));
  return parsed.data;
};
/** If the metadata is refused after the bytes were stored, the stored object is removed again. */
const discard = (req: Request) => (req.documentUpload ? documentStorage().delete(req.documentUpload.storageKey).catch(() => undefined) : Promise.resolve());

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

documentsRouter.get('/policy', viewAny, async (_req, res) => res.json({ data: documentService.policy() }));
documentsRouter.get('/categories', viewAny, async (req, res) => res.json({ data: await documentCategoryService.list(req.query.includeInactive === 'true') }));
documentsRouter.post('/categories', manage, validate(createDocumentCategorySchema), async (req, res) => res.status(201).json({ data: await documentCategoryService.create(req.body, actor(req)) }));
documentsRouter.patch('/categories/:id', manage, validate(updateDocumentCategorySchema), async (req, res) => res.json({ data: await documentCategoryService.update(id(req), req.body, actor(req)) }));

documentsRouter.get('/my', requirePermission(PERMISSIONS.DOCUMENTS_VIEW_OWN), async (req, res) => res.json({ data: await documentService.mine(req.auth!) }));
documentsRouter.get('/', view, validate(documentListQuerySchema, 'query'), async (req, res: Response) => res.json(await documentService.list(req.auth!, res.locals.query)));
documentsRouter.post('/', manage, documentUpload(), async (req, res) => {
  try {
    const input = parseFields(createDocumentSchema, req.documentUpload!.fields);
    res.status(201).json({ data: await documentService.create(req.documentUpload!, input, actor(req)) });
  } catch (e) { await discard(req); throw e; }
});
documentsRouter.get('/:id', viewAny, async (req, res) => res.json({ data: await documentService.get(req.auth!, id(req)) }));
documentsRouter.patch('/:id', manage, validate(updateDocumentSchema), async (req, res) => res.json({ data: await documentService.update(id(req), req.body, actor(req)) }));
documentsRouter.post('/:id/versions', manage, documentUpload(), async (req, res) => {
  try {
    const input = parseFields(uploadVersionSchema, req.documentUpload!.fields);
    res.status(201).json({ data: await documentService.addVersion(id(req), req.documentUpload!, input.note ?? null, actor(req)) });
  } catch (e) { await discard(req); throw e; }
});
documentsRouter.post('/:id/archive', manage, async (req, res) => res.json({ data: await documentService.archive(id(req), actor(req)) }));
documentsRouter.post('/:id/links', view, validate(linkDocumentSchema), async (req, res) => res.status(201).json({ data: await documentService.link(id(req), req.body, actor(req)) }));
documentsRouter.delete('/:id/links/:linkId', view, async (req, res) => res.json({ data: await documentService.unlink(id(req), req.params.linkId as string, actor(req)) }));

/** The only road to the bytes. `attachment` by default; `inline=1` is honoured only for PDF, images and plain text. */
documentsRouter.get('/:id/download', viewAny, validate(z.object({ versionId: z.string().min(1).optional(), inline: z.enum(['0', '1']).optional() }), 'query'), async (req, res: Response) => {
  const { version, stream, inline } = await documentService.openForDownload(req.auth!, id(req), res.locals.query.versionId ?? null, actor(req));
  const disposition = res.locals.query.inline === '1' && inline ? 'inline' : 'attachment';
  res.setHeader('Content-Type', inline ? version.mimeType : 'application/octet-stream');
  res.setHeader('Content-Length', String(version.fileSize));
  res.setHeader('Content-Disposition', `${disposition}; ${contentDispositionFilename(version.originalFilename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.pipe(res);
});

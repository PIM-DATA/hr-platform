import { z } from 'zod';
import { DOCUMENT_CLASSIFICATIONS, DOCUMENT_EXPIRY_STATES, DOCUMENT_LINK_ENTITY_TYPES, DOCUMENT_SCOPE_TYPES, DOCUMENT_STATUSES } from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema } from './common';

/**
 * Document center contracts (Task 30). Metadata travels as JSON; file bytes travel only through the authenticated
 * upload and download endpoints. Nothing here carries a storage key or a filesystem path.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
const codeField = z.string().trim().toUpperCase().min(1).max(30).regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, numbers, dash or underscore');

export const createDocumentCategorySchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  scopeType: z.enum(DOCUMENT_SCOPE_TYPES).default('GENERAL'),
  defaultClassification: z.enum(DOCUMENT_CLASSIFICATIONS).default('EMPLOYEE_PRIVATE'),
  allowedExtensions: z.array(z.string().regex(/^\.[a-z0-9]{1,8}$/)).max(20).nullable().optional(),
  maxFileSizeBytes: z.number().int().min(1024).max(500 * 1024 * 1024).nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CreateDocumentCategoryInput = z.infer<typeof createDocumentCategorySchema>;
export const updateDocumentCategorySchema = createDocumentCategorySchema.omit({ code: true }).partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateDocumentCategoryInput = z.infer<typeof updateDocumentCategorySchema>;
export interface DocumentCategoryDto {
  id: string; code: string; name: string; description: string | null;
  scopeType: (typeof DOCUMENT_SCOPE_TYPES)[number];
  defaultClassification: (typeof DOCUMENT_CLASSIFICATIONS)[number];
  allowedExtensions: string[] | null; maxFileSizeBytes: number | null; isActive: boolean;
}

/** The multipart fields that accompany a new document's file. */
export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  categoryId: z.string().min(1),
  ownerEmployeeId: z.string().min(1).nullable().optional(),
  organizationId: z.string().min(1).nullable().optional(),
  classification: z.enum(DOCUMENT_CLASSIFICATIONS).optional(),
  issuedDate: businessDate.nullable().optional(),
  expiryDate: businessDate.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  categoryId: z.string().min(1).optional(),
  classification: z.enum(DOCUMENT_CLASSIFICATIONS).optional(),
  issuedDate: businessDate.nullable().optional(),
  expiryDate: businessDate.nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export const uploadVersionSchema = z.object({ note: z.string().trim().max(500).nullable().optional() }).strict();
export const linkDocumentSchema = z.object({
  entityType: z.enum(DOCUMENT_LINK_ENTITY_TYPES),
  entityId: z.string().min(1),
  relationType: z.string().trim().max(60).nullable().optional(),
}).strict();
export type LinkDocumentInput = z.infer<typeof linkDocumentSchema>;

export const documentListQuerySchema = paginationQuerySchema.extend({
  ownerEmployeeId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  classification: z.enum(DOCUMENT_CLASSIFICATIONS).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  expiry: z.enum(DOCUMENT_EXPIRY_STATES).optional(),
  issuedFrom: businessDate.optional(),
  issuedTo: businessDate.optional(),
  entityType: z.enum(DOCUMENT_LINK_ENTITY_TYPES).optional(),
  entityId: z.string().min(1).optional(),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export interface DocumentVersionDto {
  id: string; versionNumber: number; originalFilename: string; mimeType: string; fileSize: number;
  sha256: string; uploadedBy: string | null; uploadedAt: string; note: string | null; inlinePreviewable: boolean;
}
export interface DocumentLinkDto { id: string; entityType: (typeof DOCUMENT_LINK_ENTITY_TYPES)[number]; entityId: string; relationType: string | null; label: string | null; createdAt: string }
export interface DocumentDto {
  id: string; documentNumber: string; title: string; description: string | null;
  category: { id: string; code: string; name: string; scopeType: string };
  owner: { id: string; employeeCode: string; firstName: string; lastName: string } | null;
  organization: { id: string; name: string } | null;
  classification: (typeof DOCUMENT_CLASSIFICATIONS)[number];
  status: (typeof DOCUMENT_STATUSES)[number];
  issuedDate: string | null; expiryDate: string | null; expiryState: (typeof DOCUMENT_EXPIRY_STATES)[number];
  currentVersion: DocumentVersionDto | null;
  versionCount: number;
  links: DocumentLinkDto[];
  /** What the caller may do — computed server-side, mirrored by the UI. */
  can: { download: boolean; manage: boolean };
  archivedAt: string | null; createdAt: string; updatedAt: string;
}
export interface DocumentDetailDto extends DocumentDto { versions: DocumentVersionDto[] }
export interface DocumentPolicyDto { maxFileSizeBytes: number; allowedExtensions: string[]; inlineExtensions: string[]; malwareScanning: false }

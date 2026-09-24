import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDocumentCategoryInput, DocumentCategoryDto, DocumentDetailDto, DocumentDto, DocumentPolicyDto, LinkDocumentInput, UpdateDocumentCategoryInput, UpdateDocumentInput } from '@hr/shared';
import { api, ApiClientError, getCsrfToken } from '@/lib/api-client';

const KEY = 'documents';
const BASE = `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')}/api/v1/documents`;
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };

export const useDocumentPolicy = () => useQuery({ queryKey: [KEY, 'policy'], queryFn: () => api.get<DocumentPolicyDto>('/documents/policy').then((r) => r.data), staleTime: 300_000 });
export const useDocumentCategories = (includeInactive = false) => useQuery({ queryKey: [KEY, 'categories', includeInactive], queryFn: () => api.get<DocumentCategoryDto[]>(`/documents/categories?includeInactive=${includeInactive}`).then((r) => r.data) });
export const useMyDocuments = () => useQuery({ queryKey: [KEY, 'my'], queryFn: () => api.get<DocumentDto[]>('/documents/my').then((r) => r.data) });
export const useDocuments = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'list', f], queryFn: () => api.get<DocumentDto[]>(`/documents?${qs(f)}`), placeholderData: (p) => p });
export const useDocument = (id: string | null) => useQuery({ queryKey: [KEY, 'detail', id ?? ''], queryFn: () => api.get<DocumentDetailDto>(`/documents/${id}`).then((r) => r.data), enabled: !!id });

/** Multipart upload: the file plus its metadata fields, straight to the API (the JSON client cannot carry a File). */
async function postFile<T>(path: string, file: File, fields: Record<string, string | null | undefined>): Promise<T> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') body.append(k, v);
  body.append('file', file, file.name);
  const csrf = getCsrfToken();
  const res = await fetch(`${BASE}${path}`, { method: 'POST', credentials: 'include', headers: csrf ? { 'x-csrf-token': csrf } : undefined, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiClientError(res.status, json?.error ?? { code: 'UPLOAD_FAILED', message: res.statusText });
  return json.data as T;
}

/** The download URL is only ever fetched by the browser with the session cookie; there is no public file URL. */
export const documentDownloadUrl = (id: string, versionId?: string, inline = false) => `${BASE}/${id}/download?${qs({ versionId, inline: inline ? '1' : undefined })}`;

export function useDocumentMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });
  return {
    upload: useMutation({ mutationFn: ({ file, fields }: { file: File; fields: Record<string, string | null | undefined> }) => postFile<DocumentDetailDto>('', file, fields), onSuccess: invalidate }),
    uploadVersion: useMutation({ mutationFn: ({ id, file, note }: { id: string; file: File; note?: string }) => postFile<DocumentDetailDto>(`/${id}/versions`, file, { note }), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateDocumentInput }) => api.patch<DocumentDetailDto>(`/documents/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    archive: useMutation({ mutationFn: (id: string) => api.post<DocumentDetailDto>(`/documents/${id}/archive`).then((r) => r.data), onSuccess: invalidate }),
    link: useMutation({ mutationFn: ({ id, input }: { id: string; input: LinkDocumentInput }) => api.post<DocumentDetailDto>(`/documents/${id}/links`, input).then((r) => r.data), onSuccess: invalidate }),
    unlink: useMutation({ mutationFn: ({ id, linkId }: { id: string; linkId: string }) => api.delete<DocumentDetailDto>(`/documents/${id}/links/${linkId}`).then((r) => r.data), onSuccess: invalidate }),
    createCategory: useMutation({ mutationFn: (input: CreateDocumentCategoryInput) => api.post<DocumentCategoryDto>('/documents/categories', input).then((r) => r.data), onSuccess: invalidate }),
    updateCategory: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateDocumentCategoryInput }) => api.patch<DocumentCategoryDto>(`/documents/categories/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
  };
}

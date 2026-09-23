import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingImportRunDto, OnboardingPreviewDto } from '@hr/shared';
import { api, getCsrfToken } from '@/lib/api-client';

const BASE = '/api/v1/onboarding';
export const onboardingKeys = { imports: (f: Record<string, unknown>) => ['onboarding', 'imports', f] as const };

/** The workbook is sent as multipart, so these two calls bypass the JSON client and post the File directly. */
async function postFile<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  body.append('file', file, file.name);
  const csrf = getCsrfToken();
  const res = await fetch(`${BASE}${path}`, { method: 'POST', credentials: 'include', headers: csrf ? { 'x-csrf-token': csrf } : undefined, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiUploadError(res.status, json?.error ?? { code: 'UNKNOWN', message: res.statusText });
  return json.data as T;
}

export class ApiUploadError extends Error {
  constructor(public readonly status: number, public readonly error: { code: string; message: string }) {
    super(error.message);
    this.name = 'ApiUploadError';
  }
}

export const useImportHistory = (f: Record<string, unknown>) =>
  useQuery({ queryKey: onboardingKeys.imports(f), queryFn: () => api.get<OnboardingImportRunDto[]>(`/onboarding/imports?page=${f.page}&pageSize=${f.pageSize}`), placeholderData: (p) => p });

export function useOnboardingMutations() {
  const qc = useQueryClient();
  return {
    preview: useMutation({ mutationFn: (file: File) => postFile<OnboardingPreviewDto>('/preview', file) }),
    commit: useMutation({
      mutationFn: ({ file, expectedSha256 }: { file: File; expectedSha256: string }) => postFile<OnboardingImportRunDto>('/commit', file, { expectedSha256 }),
      // An import creates organizations, departments, positions and employees, so every list that shows them is stale.
      onSuccess: () => {
        for (const key of [['onboarding'], ['organization'], ['employees'], ['dashboard'], ['leave-settings'], ['leave']]) qc.invalidateQueries({ queryKey: key });
      },
    }),
  };
}

/** Streams the generated template to the browser as a download. */
export async function downloadTemplate(): Promise<void> {
  const res = await fetch(`${BASE}/template`, { credentials: 'include' });
  if (!res.ok) throw new ApiUploadError(res.status, { code: 'TEMPLATE_DOWNLOAD_FAILED', message: 'Could not download the template' });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'hr-onboarding-template.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

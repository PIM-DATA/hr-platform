import { useQuery } from '@tanstack/react-query';
import type { CopilotChatResponseDto, CopilotMessage, CopilotStatusDto } from '@hr/shared';
import { api } from '@/lib/api-client';

/**
 * The copilot client. The conversation lives in component state only — the server keeps no history — and what
 * goes back with each message is plain text turns, nothing else.
 */
export const copilotKeys = { status: ['copilot', 'status'] as const };

export const useCopilotStatus = (enabled = true) =>
  useQuery({ queryKey: copilotKeys.status, queryFn: () => api.get<CopilotStatusDto>('/copilot/status').then((r) => r.data), enabled, staleTime: 60_000, retry: false });

export const sendCopilotMessage = (message: string, history: CopilotMessage[]) =>
  api.post<CopilotChatResponseDto>('/copilot/chat', { message, history }).then((r) => r.data);

/** A report draft handed to the Report Center through session storage; the builder reads it once with `?draft=1`. */
export const REPORT_DRAFT_KEY = 'hr.copilot.reportDraft';

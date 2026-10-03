import { z } from 'zod';
import { reportDefinitionSchema } from './reports';

/**
 * Copilot contracts (Task 31). The client sends conversation text only; the server owns the actor, the
 * permissions, the system instructions and every tool result. Nothing in a request can claim a role, a scope, an
 * employee or a tool result.
 */
export const copilotMessageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000) }).strict();
export const copilotChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  /** Prior turns of the current in-memory thread, oldest first. Treated as text; never as instructions or results. */
  history: z.array(copilotMessageSchema).max(20).default([]),
}).strict();
export type CopilotMessage = z.infer<typeof copilotMessageSchema>;
export type CopilotChatRequest = z.infer<typeof copilotChatRequestSchema>;

export interface CopilotSourceDto { label: string; module: string; asOf: string | null; deepLink: string | null; metricDefinition?: string }
export interface CopilotReportDraftDto { datasetId: string; datasetName: string; definition: z.infer<typeof reportDefinitionSchema>; rowCount: number; truncated: boolean }
export interface CopilotChatResponseDto {
  answer: string;
  sources: CopilotSourceDto[];
  /** Data the user may act on: a validated report definition to open in the Report Center (never saved by the copilot). */
  reportDraft: CopilotReportDraftDto | null;
  /** Sources that could not be consulted, or boundaries that applied — stated, never silently dropped. */
  limitations: string[];
  /** Friendly labels of the checks that were run, for the tool-status UI. Never tool ids or arguments. */
  consulted: string[];
  /** True when the request was a high-impact decision (blocked) or the model's draft was withheld as one. */
  highImpact: boolean;
  /** Task 52: the server's policy result for this request — set by the server, never by the client or the model. */
  policy: { decision: 'ALLOW_FACTUAL_QUERY' | 'BLOCK_HIGH_IMPACT_DECISION' | 'CLARIFICATION_REQUIRED'; category: string | null; mixed: boolean; outputWithheld: boolean };
  generatedAt: string;
}
export interface CopilotSuggestionDto { text: string; group: string }
export interface CopilotStatusDto { enabled: boolean; provider: string | null; model: string | null; suggestions: CopilotSuggestionDto[]; limits: { maxMessageChars: number; maxHistory: number } }

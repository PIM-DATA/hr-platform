import { env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';

/**
 * The provider boundary. Everything the model can see or ask for passes through this interface: the system
 * instructions, the conversation, the tool definitions the server chose to offer, and a token cap. A provider never
 * sees a Prisma client, a credential, a path or a storage key. Provider-specific wire formats live only here.
 */
export interface ProviderTool { id: string; description: string; inputSchema: Record<string, unknown> }
export type ProviderMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; toolCalls: { id: string; toolId: string; args: unknown }[] }
  | { role: 'tool'; toolCallId: string; toolId: string; result: unknown; error?: string };
export interface ProviderRequest { systemInstructions: string; messages: ProviderMessage[]; tools: ProviderTool[]; maxOutputTokens: number; signal: AbortSignal }
export type ProviderResponse =
  | { kind: 'answer'; text: string; usage: { inputTokens: number; outputTokens: number } | null }
  | { kind: 'tool_calls'; calls: { id: string; toolId: string; args: unknown }[]; usage: { inputTokens: number; outputTokens: number } | null };
export interface CopilotProvider { readonly name: string; readonly model: string; chat(req: ProviderRequest): Promise<ProviderResponse> }

const log = logger.child({ module: 'copilot' });

// ---------------------------------------------------------------------------
// Anthropic Messages API, over fetch. No SDK dependency; the key is read from config and never logged.
// ---------------------------------------------------------------------------
export class AnthropicCopilotProvider implements CopilotProvider {
  readonly name = 'anthropic';
  constructor(readonly model: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async chat(req: ProviderRequest): Promise<ProviderResponse> {
    const messages = req.messages.map((m) => {
      if ('toolCalls' in m) return { role: 'assistant', content: m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.toolId, input: c.args ?? {} })) };
      if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: JSON.stringify(m.error ? { error: m.error } : m.result), is_error: !!m.error }] };
      return { role: m.role, content: m.content };
    });
    const body = {
      model: this.model, max_tokens: req.maxOutputTokens, system: req.systemInstructions, messages,
      tools: req.tools.map((t) => ({ name: t.id, description: t.description, input_schema: t.inputSchema })),
    };
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', signal: req.signal, headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    } catch (e) {
      throw new AppError(503, 'COPILOT_UNAVAILABLE', 'The AI provider could not be reached');
    }
    if (!res.ok) {
      log.warn({ status: res.status }, 'copilot provider rejected the request');
      throw new AppError(res.status === 429 ? 429 : 503, res.status === 429 ? 'COPILOT_RATE_LIMITED' : 'COPILOT_UNAVAILABLE', res.status === 429 ? 'The AI provider is rate limiting requests; try again shortly' : 'The AI provider returned an error');
    }
    const json = (await res.json()) as { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string };
    const usage = json.usage ? { inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 } : null;
    const calls = (json.content ?? []).filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id ?? '', toolId: c.name ?? '', args: c.input }));
    if (calls.length) return { kind: 'tool_calls', calls, usage };
    return { kind: 'answer', text: (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim(), usage };
  }
}

// ---------------------------------------------------------------------------
// Deterministic test double. Scripted by tests; unscripted it behaves like a small, honest assistant: it picks a
// tool by keyword, then answers from the tool data it was given, never from anywhere else.
// ---------------------------------------------------------------------------
export type FakeStep = ProviderResponse | { kind: 'error'; status?: number } | { kind: 'timeout' } | ((req: ProviderRequest) => ProviderResponse);
let script: FakeStep[] = [];
export const scriptFakeProvider = (steps: FakeStep[]) => { script = [...steps]; };

const KEYWORDS: [RegExp, string][] = [
  [/สรุปภาพ|overview|ภาพรวม|summary of hr|hr this month/i, 'executive_hr_overview'],
  [/รายงาน|report|แยก ?department|by department|active employees/i, 'report_query'],
  [/funnel|recruit|time.?to.?hire|candidate|ผู้สมัคร|รับสมัคร/i, 'recruitment_summary'],
  [/succession|successor|สืบทอด|ทายาท/i, 'succession_coverage'],
  [/ทีม|team/i, 'team_summary'],
  [/ลา|leave|balance|วันหยุด/i, 'leave_balance_and_recent'],
  [/attendance|มาสาย|late|เข้างาน|ขาด/i, 'attendance_summary'],
  [/overtime|ot\b|โอที|ล่วงเวลา/i, 'overtime_summary'],
  [/performance|ประเมิน|score|rating/i, 'performance_summary'],
  [/skill|gap|competenc|สมรรถนะ|ทักษะ/i, 'competency_skill_gap'],
  [/training|course|idp|อบรม|พัฒนา|development/i, 'training_development_summary'],
  [/career|readiness|เส้นทาง|ตำแหน่งถัดไป/i, 'career_readiness'],
  [/document|เอกสาร|contract|สัญญา|certificate/i, 'document_metadata_search'],
  [/metric|definition|คิดยังไง|คำนวณ|formula|นิยาม/i, 'analytics_metric_definition'],
  [/payslip|สลิป|เงินเดือน|salary/i, 'employee_self_summary'],
  [/headcount|พนักงาน|employees/i, 'report_query'],
];
export class FakeCopilotProvider implements CopilotProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  async chat(req: ProviderRequest): Promise<ProviderResponse> {
    const step = script.shift();
    if (step) {
      if (typeof step === 'function') return step(req);
      if (step.kind === 'error') throw new AppError(step.status === 429 ? 429 : 503, step.status === 429 ? 'COPILOT_RATE_LIMITED' : 'COPILOT_UNAVAILABLE', 'The AI provider returned an error');
      if (step.kind === 'timeout') { await new Promise((r) => setTimeout(r, 200)); if (req.signal.aborted) throw new AppError(504, 'COPILOT_TIMEOUT', 'The AI provider did not answer in time'); return { kind: 'answer', text: 'late', usage: null }; }
      return step;
    }
    const lastUser = [...req.messages].reverse().find((m) => 'content' in m && m.role === 'user');
    const results = req.messages.filter((m): m is Extract<ProviderMessage, { role: 'tool' }> => m.role === 'tool');
    if (results.length === 0 && lastUser && 'content' in lastUser) {
      const offered = new Set(req.tools.map((t) => t.id));
      const wanted = KEYWORDS.filter(([re]) => re.test(lastUser.content)).map(([, id]) => id).filter((id) => offered.has(id));
      const unique = [...new Set(wanted)].slice(0, 3);
      if (unique.length) return { kind: 'tool_calls', calls: unique.map((toolId, i) => ({ id: `call_${i}`, toolId, args: toolId === 'report_query' ? { datasetId: 'headcount_summary', definition: { columns: ['department'], filters: [{ fieldId: 'employmentStatus', operator: 'EQ', value: 'ACTIVE' }], sort: [], groupBy: ['department'], aggregations: [{ fieldId: 'employees', function: 'COUNT', alias: 'Employees' }], pageSize: 50 } } : toolId === 'analytics_metric_definition' ? { search: lastUser.content.slice(0, 60) } : {} })), usage: null };
      return { kind: 'answer', text: `General explanation (no company data was consulted): ${lastUser.content.slice(0, 120)}`, usage: null };
    }
    const lines = results.map((r) => (r.error ? `${r.toolId}: unavailable (${r.error})` : `${r.toolId}: ${JSON.stringify(r.result).slice(0, 1200)}`));
    return { kind: 'answer', text: results.every((r) => r.error || isEmpty(r.result)) ? 'No data was found in the system for what you are authorized to see.' : `Based on the system data:\n${lines.join('\n')}`, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}
const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && Object.keys(v as object).length === 0);

let instance: CopilotProvider | null = null;
/** Tests flip the configuration at runtime; the cached provider must follow. */
export const resetCopilotProvider = () => { instance = null; script = []; };
export function copilotProvider(): CopilotProvider {
  if (!env.COPILOT_ENABLED) throw new AppError(503, 'COPILOT_DISABLED', 'The HR Copilot is not enabled on this installation');
  if (!instance) {
    if (env.COPILOT_PROVIDER === 'fake') instance = new FakeCopilotProvider();
    else { if (!env.COPILOT_API_KEY) throw new AppError(503, 'COPILOT_UNAVAILABLE', 'The AI provider is not configured'); instance = new AnthropicCopilotProvider(env.COPILOT_MODEL, env.COPILOT_API_KEY); }
  }
  return instance;
}
export const copilotStatus = (): 'disabled' | 'configured' => (env.COPILOT_ENABLED && (env.COPILOT_PROVIDER === 'fake' || !!env.COPILOT_API_KEY) ? 'configured' : 'disabled');

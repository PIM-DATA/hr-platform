import type { CopilotPolicyResult } from '@hr/shared';
import { AppError } from '../../lib/errors';

/**
 * Task 52 (T44-P1-22), Layer B — tool dispatch requires a server-issued permit.
 *
 * The orchestrator issues a permit only after the pre-orchestration policy returned ALLOW_FACTUAL_QUERY for this
 * request, and every registered copilot tool checks it before its handler runs. A permit is an object this module
 * created and remembers (a WeakSet), so a hand-built `{ decision: 'ALLOW_FACTUAL_QUERY' }` — from a test, a future
 * caller or anything derived from the request or the model — is not one. A blocked or clarification request never
 * gets a permit, so no path through the tool registry can reach a source module for it.
 */
export interface DispatchPermit { readonly decision: 'ALLOW_FACTUAL_QUERY'; readonly requestId: string }
const issued = new WeakSet<object>();

export function issueDispatchPermit(policy: Pick<CopilotPolicyResult, 'decision'>, requestId: string): DispatchPermit {
  if (policy.decision !== 'ALLOW_FACTUAL_QUERY') throw new AppError(403, 'COPILOT_POLICY_BLOCKED', 'This request may not look up HR data');
  const permit: DispatchPermit = Object.freeze({ decision: 'ALLOW_FACTUAL_QUERY', requestId });
  issued.add(permit);
  return permit;
}

export function assertDispatchAllowed(policy: unknown): void {
  if (!policy || typeof policy !== 'object' || !issued.has(policy)) throw new AppError(403, 'COPILOT_POLICY_BLOCKED', 'This request may not look up HR data');
}

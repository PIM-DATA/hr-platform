import { Router, type NextFunction, type Request, type Response } from 'express';
import { PERMISSIONS, copilotChatRequestSchema, type CopilotStatusDto, type CopilotSuggestionDto } from '@hr/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { copilotOrchestrator } from './orchestrator';
import { copilotStatus } from './provider';
import { mayRollup } from '../analytics/domain-rollups';

/**
 * HR Copilot (Task 31). `copilot.use` opens the endpoint and grants no data; the tools decide the rest.
 * A dedicated per-user limiter keeps one user from spending the provider budget.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const use = requirePermission(PERMISSIONS.COPILOT_USE);

const windows = new Map<string, { count: number; resetAt: number }>();
export const resetCopilotRateLimiter = () => windows.clear();
function copilotRateLimiter(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = req.auth!.userId;
  const w = windows.get(key);
  const window = w && w.resetAt > now ? w : { count: 0, resetAt: now + 60_000 };
  window.count += 1; windows.set(key, window);
  if (windows.size > 10_000) for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
  res.setHeader('RateLimit-Limit', String(env.COPILOT_RATE_LIMIT));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, env.COPILOT_RATE_LIMIT - window.count)));
  if (window.count > env.COPILOT_RATE_LIMIT) return next(new AppError(429, 'COPILOT_RATE_LIMITED', `You can send ${env.COPILOT_RATE_LIMIT} copilot messages per minute; wait a moment`));
  next();
}

/** Role-aware suggestions, computed from permissions — never a prompt the actor could not run, never a decision prompt. */
export function suggestionsFor(auth: AuthContext): CopilotSuggestionDto[] {
  const has = (p: string) => hasPermission(auth, p);
  const out: CopilotSuggestionDto[] = [];
  if (auth.employeeId) {
    if (has(PERMISSIONS.LEAVE_REQUEST) || has(PERMISSIONS.LEAVE_VIEW)) out.push({ text: 'วันลาคงเหลือของฉันปีนี้', group: 'ของฉัน' });
    if (has(PERMISSIONS.ATTENDANCE_CLOCK) || has(PERMISSIONS.ATTENDANCE_VIEW)) out.push({ text: 'Attendance ของฉันเดือนนี้ มาสายกี่ครั้ง', group: 'ของฉัน' });
    if (has(PERMISSIONS.PERFORMANCE_VIEW)) out.push({ text: 'ผล Performance ล่าสุดของฉัน', group: 'ของฉัน' });
    if (has(PERMISSIONS.COMPETENCY_VIEW)) out.push({ text: 'Skill gap ของฉันมีอะไรบ้าง', group: 'ของฉัน' });
    if (has(PERMISSIONS.TRAINING_VIEW)) out.push({ text: 'Training ที่กำลังจะถึงของฉัน', group: 'ของฉัน' });
  }
  if (auth.dataScope === 'TEAM' && auth.employeeId && (has(PERMISSIONS.LEAVE_VIEW) || has(PERMISSIONS.ATTENDANCE_VIEW))) {
    out.push({ text: 'วันนี้ทีมฉันมีใครลา และ attendance เป็นยังไง', group: 'ทีม' });
    if (has(PERMISSIONS.PERFORMANCE_VIEW)) out.push({ text: 'ทีมมี Performance review ค้างที่ฉันต้องทำกี่คน', group: 'ทีม' });
    if (has(PERMISSIONS.TRAINING_VIEW)) out.push({ text: 'Training และ development ของทีมเป็นยังไง', group: 'ทีม' });
  }
  // Before the older HR prompts so the 10-item cap does not drop them for broad roles such as HR_ADMIN.
  const exec = has(PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE);
  if (mayRollup(auth, 'benefits') && mayRollup(auth, 'expense')) out.push({ text: 'สรุปภาพรวมสวัสดิการและค่าใช้จ่ายเดือนนี้', group: exec ? 'ภาพรวม' : 'HR' });
  if (mayRollup(auth, 'employeeServices')) out.push({ text: 'ตอนนี้มีคำขอ Employee Services ค้างอยู่กี่รายการ', group: exec ? 'ภาพรวม' : 'HR' });
  if (has(PERMISSIONS.REPORTS_VIEW)) out.push({ text: 'ทำรายงานจำนวนพนักงาน active แยก department', group: 'รายงาน' });
  if (has(PERMISSIONS.RECRUITMENT_MANAGE)) out.push({ text: 'ปีนี้ recruitment funnel เป็นยังไง และ time-to-hire เท่าไร', group: 'HR' });
  if (has(PERMISSIONS.COMPETENCY_MANAGE)) out.push({ text: 'Skill gaps ที่พบบ่อยที่สุดในองค์กร', group: 'HR' });
  if (has(PERMISSIONS.TALENT_VIEW_REPORTS)) out.push({ text: 'Succession coverage ตอนนี้เป็นอย่างไร', group: has(PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE) ? 'ภาพรวม' : 'HR' });
  if (has(PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE)) { out.push({ text: 'สรุปภาพรวม HR เดือนนี้', group: 'ภาพรวม' }); out.push({ text: 'Training completion rate คิดยังไง', group: 'ภาพรวม' }); }
  if (has(PERMISSIONS.DOCUMENTS_VIEW_OWN) && auth.employeeId) out.push({ text: 'เอกสารของฉันมีอะไรบ้าง และมีอะไรใกล้หมดอายุไหม', group: 'เอกสาร' });
  return out.slice(0, 10);
}
type AuthContext = NonNullable<Request['auth']>;

export const copilotRouter = Router();
copilotRouter.use(requireAuth);

copilotRouter.get('/status', use, (req, res) => {
  const enabled = copilotStatus() === 'configured';
  const dto: CopilotStatusDto = { enabled, provider: enabled ? env.COPILOT_PROVIDER : null, model: enabled ? env.COPILOT_MODEL : null, suggestions: enabled ? suggestionsFor(req.auth!) : [], limits: { maxMessageChars: 4000, maxHistory: 20 } };
  res.json({ data: dto });
});
copilotRouter.post('/chat', use, copilotRateLimiter, validate(copilotChatRequestSchema), async (req, res) => res.json({ data: await copilotOrchestrator.chat(actor(req), req.body) }));

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bot, Clock, ExternalLink, ShieldAlert, Sparkles, Trash2, User } from 'lucide-react';
import type { CopilotChatResponseDto, CopilotMessage, CopilotSourceDto } from '@hr/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { REPORT_DRAFT_KEY, sendCopilotMessage, useCopilotStatus } from './copilot.api';

/**
 * HR Copilot — a dedicated page with one in-memory conversation.
 *
 * Every answer comes with the sources the server's tools actually consulted ("แหล่งข้อมูล"); nothing else is shown
 * as a citation. A report the copilot drafted opens in the Report Center builder for the user to review, run and
 * save themselves. Clearing the conversation forgets it here, and there is nowhere else it lives.
 */
interface Turn { id: number; role: 'user' | 'assistant'; content: string; response?: CopilotChatResponseDto; error?: string }

const MODULE_LABEL: Record<string, string> = { employees: 'Employees', employee360: 'Employee 360', leave: 'Leave', attendance: 'Attendance', overtime: 'Overtime', performance: 'Performance', competency: 'Competency', training: 'Training', talent: 'Career & talent', analytics: 'Analytics', recruitment: 'Recruitment', reports: 'Report Center', documents: 'Documents', payroll: 'Payroll' };
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

function SourceChip({ s }: { s: CopilotSourceDto }) {
  const inner = (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700" title={s.metricDefinition ?? undefined}>
      <span className="font-medium text-slate-900">{MODULE_LABEL[s.module] ?? s.module}</span>
      <span className="truncate">· {s.label}</span>
      {s.asOf && <span className="text-slate-400">· {fmtTime(s.asOf)}</span>}
      {s.deepLink && <ExternalLink className="h-3 w-3 text-brand-600" />}
    </span>
  );
  return s.deepLink ? <Link to={s.deepLink} className="max-w-full hover:opacity-80">{inner}</Link> : inner;
}

export function CopilotPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const status = useCopilotStatus();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const seq = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns, busy]);

  const ask = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    // A refused exchange (high-impact request + the server's boundary answer) is not sent back as context. This is a
    // convenience only — the server classifies whatever history arrives and enforces the policy itself.
    const refused = new Set<number>();
    turns.forEach((t, i) => { if (t.response && (t.response.policy.decision === 'BLOCK_HIGH_IMPACT_DECISION' || t.response.policy.outputWithheld)) { refused.add(t.id); if (turns[i - 1]?.role === 'user') refused.add(turns[i - 1]!.id); } });
    const history: CopilotMessage[] = turns.filter((t) => !t.error && !refused.has(t.id)).slice(-20).map((t) => ({ role: t.role, content: t.content }));
    const userTurn: Turn = { id: ++seq.current, role: 'user', content: message };
    setTurns((prev) => [...prev, userTurn]);
    setInput(''); setBusy(true); setStatusText('กำลังตรวจข้อมูลในระบบ…');
    const slow = setTimeout(() => setStatusText('กำลังรวบรวมข้อมูลจากหลายโมดูล…'), 2500);
    try {
      const response = await sendCopilotMessage(message, history);
      setTurns((prev) => [...prev, { id: ++seq.current, role: 'assistant', content: response.answer, response }]);
    } catch (e) {
      setTurns((prev) => [...prev, { id: ++seq.current, role: 'assistant', content: '', error: errorMessage(e) }]);
    } finally { clearTimeout(slow); setBusy(false); setStatusText(null); box.current?.focus(); }
  };
  const openDraft = (r: CopilotChatResponseDto) => {
    if (!r.reportDraft) return;
    try { sessionStorage.setItem(REPORT_DRAFT_KEY, JSON.stringify(r.reportDraft)); } catch { /* storage unavailable: the builder opens empty */ }
    navigate('/hrm/reports/builder?draft=1');
  };

  if (status.isLoading) return <LoadingBlock />;
  if (status.isError || !status.data?.enabled) {
    return (
      <>
        <PageHeader title="HR Copilot" description="ผู้ช่วยตอบคำถาม HR จากข้อมูลในระบบตามสิทธิ์ของคุณ" />
        <Card className="p-8 text-center">
          <Bot className="mx-auto mb-3 h-8 w-8 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-900">HR Copilot ยังไม่เปิดใช้งานในระบบนี้</h3>
          <p className="mt-1 text-sm text-slate-500">ผู้ดูแลระบบสามารถเปิดใช้ได้จากการตั้งค่า (COPILOT_ENABLED) ฟีเจอร์อื่นทั้งหมดใช้งานได้ตามปกติ</p>
        </Card>
      </>
    );
  }
  const suggestions = status.data.suggestions;
  const groups = [...new Set(suggestions.map((s) => s.group))];

  return (
    <div className="flex h-full min-h-[70vh] flex-col">
      <PageHeader title="HR Copilot" description="ตอบจากข้อมูลในระบบที่คุณมีสิทธิ์เห็นเท่านั้น อ่านอย่างเดียว ไม่ตัดสินใจแทน HR" actions={turns.length > 0 ? <Button variant="secondary" onClick={() => setTurns([])} disabled={busy}><Trash2 className="h-4 w-4" /> ล้างการสนทนา</Button> : undefined} />
      <Card className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 space-y-4 overflow-y-auto p-4" data-testid="copilot-thread">
          {turns.length === 0 && (
            <div className="mx-auto max-w-2xl py-6 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Sparkles className="h-6 w-6" /></div>
              <h3 className="text-base font-semibold text-slate-900">สวัสดี{user?.employee ? ` ${user.employee.firstName}` : ''} — ถามเรื่อง HR ของคุณได้เลย</h3>
              <p className="mt-1 text-sm text-slate-500">ทุกคำตอบมาจากข้อมูลในระบบพร้อมระบุแหล่งข้อมูล ถ้าไม่มีข้อมูลหรือไม่มีสิทธิ์ ฉันจะบอกตรง ๆ และไม่เดา</p>
              <div className="mt-6 space-y-4 text-left">
                {groups.map((g) => (
                  <div key={g}>
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{g}</div>
                    <div className="flex flex-wrap gap-2">{suggestions.filter((s) => s.group === g).map((s) => <button key={s.text} type="button" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand-300 hover:bg-brand-50" onClick={() => ask(s.text)}>{s.text}</button>)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className={t.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`flex max-w-full gap-2 sm:max-w-[85%] ${t.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${t.role === 'user' ? 'bg-slate-200 text-slate-700' : 'bg-brand-100 text-brand-700'}`}>{t.role === 'user' ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}</div>
                <div className="min-w-0">
                  {t.error ? <Alert tone="error">{t.error}</Alert> : (
                    <div className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm ${t.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-900'}`}>{t.content}</div>
                  )}
                  {t.response && (
                    <div className="mt-2 space-y-2">
                      {t.response.policy.decision !== 'ALLOW_FACTUAL_QUERY' && (
                        <div className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-800" data-testid="copilot-policy">
                          <ShieldAlert className="h-3.5 w-3.5" /> {t.response.policy.decision === 'BLOCK_HIGH_IMPACT_DECISION' ? 'ขอบเขตการตัดสินใจ — Copilot ไม่ตัดสิน ไม่จัดอันดับ และไม่ค้นข้อมูลสำหรับคำขอนี้' : 'ต้องการคำอธิบายเพิ่ม — ยังไม่มีการค้นข้อมูล'}
                        </div>
                      )}
                      {t.response.limitations.length > 0 && <ul className="space-y-0.5 text-xs text-amber-700">{t.response.limitations.map((l) => <li key={l}>⚠ {l}</li>)}</ul>}
                      {t.response.reportDraft && (
                        <div className="rounded-md border border-brand-200 bg-brand-50 p-3 text-sm">
                          <div className="font-medium text-slate-900">ร่างรายงาน: {t.response.reportDraft.datasetName}</div>
                          <div className="text-xs text-slate-600">{t.response.reportDraft.rowCount} แถว{t.response.reportDraft.truncated ? ' (แสดงบางส่วนในคำตอบ)' : ''} · ยังไม่ได้บันทึก — เปิดใน Report Center เพื่อตรวจ แก้ไข และบันทึกเอง</div>
                          <Button size="sm" className="mt-2" onClick={() => openDraft(t.response!)}>Open in Report Center</Button>
                        </div>
                      )}
                      {t.response.sources.length > 0 && (
                        <div>
                          <div className="mb-1 text-xs font-medium text-slate-500">แหล่งข้อมูล</div>
                          <div className="flex flex-wrap gap-1.5">{t.response.sources.map((s) => <SourceChip key={`${s.module}:${s.label}`} s={s} />)}</div>
                        </div>
                      )}
                      <div className="flex items-center gap-1 text-[11px] text-slate-400"><Clock className="h-3 w-3" /> ข้อมูล ณ {fmtTime(t.response.generatedAt)}{t.response.consulted.length > 0 && <> · ตรวจแล้ว: {t.response.consulted.join(', ')}</>}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {busy && <div className="flex items-center gap-2 text-sm text-slate-500" role="status"><span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-500" />{statusText}</div>}
          <div ref={bottom} />
        </div>
        <form className="border-t border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
          <div className="flex items-end gap-2">
            <textarea ref={box} aria-label="ถาม HR Copilot" rows={1} maxLength={status.data.limits.maxMessageChars} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }} placeholder="พิมพ์คำถาม เช่น วันลาคงเหลือของฉันปีนี้" className="block max-h-40 min-h-[42px] w-full flex-1 resize-y rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" disabled={busy} />
            <Button type="submit" loading={busy} disabled={!input.trim()}>ส่ง</Button>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">คำถามและข้อมูลที่ระบบดึงมาตอบจะถูกส่งไปยังผู้ให้บริการ AI ที่องค์กรกำหนด ({status.data.provider}) · ไม่บันทึกประวัติการสนทนาบนเซิร์ฟเวอร์ · Copilot อ่านข้อมูลอย่างเดียวและไม่ตัดสินใจด้านการจ้างงาน</p>
        </form>
      </Card>
    </div>
  );
}

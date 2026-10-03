import { HIGH_IMPACT_NOTICE } from './copilot';

/**
 * Task 52 (T44-P1-22) — the Copilot high-impact execution policy. Pure: no provider, no I/O.
 *
 * The server calls `evaluateCopilotPolicy` on the effective request (the current message and the client-sent history
 * the provider would see) BEFORE any provider or tool work. Only ALLOW_FACTUAL_QUERY proceeds; the other two results
 * are answered with the deterministic, server-owned text below. Nothing in the request can set the result — there is
 * no client flag, and the provider's output never feeds back into it.
 *
 * The classifier looks for intent, not single words: a decision object (dismissal, discipline, promotion/selection,
 * pay) only counts together with a judgment ("should", "deserve", "ควร", "เหมาะ"…) or a ranking of people; an
 * inference topic (fraud, health, financial distress) only together with a person or an inference cue ("likely",
 * "ดูจาก", "น่าจะ"…). That is why "What is our termination process?" and "How many disciplinary cases were closed?"
 * stay factual while "ควรเลิกจ้างใคร" does not. It is a deterministic rule set, not a language model: it can miss a
 * paraphrase it has never seen (docs/hr-copilot.md — known limitations), which is why tool dispatch (Layer B) and
 * the source modules' own authorization (Layer C) do not rely on it.
 */
export const COPILOT_POLICY_DECISIONS = ['ALLOW_FACTUAL_QUERY', 'BLOCK_HIGH_IMPACT_DECISION', 'CLARIFICATION_REQUIRED'] as const;
export type CopilotPolicyDecision = (typeof COPILOT_POLICY_DECISIONS)[number];
export const COPILOT_POLICY_CATEGORIES = [
  'TERMINATION', 'DISCIPLINE', 'PROMOTION_SELECTION', 'COMPENSATION', 'PERFORMANCE_RANKING', 'TALENT_RANKING',
  'FRAUD_INFERENCE', 'HEALTH_INFERENCE', 'FINANCIAL_DISTRESS_INFERENCE', 'COMBINED_PROFILING', 'AMBIGUOUS_PERSON_JUDGMENT',
] as const;
export type CopilotPolicyCategory = (typeof COPILOT_POLICY_CATEGORIES)[number];
type BlockCategory = Exclude<CopilotPolicyCategory, 'AMBIGUOUS_PERSON_JUDGMENT'>;

export interface CopilotIntent {
  decision: CopilotPolicyDecision;
  /** The primary category; null when allowed. */
  category: CopilotPolicyCategory | null;
  categories: CopilotPolicyCategory[];
  /** Blocked, but the message also holds a separate factual question the user can ask on its own. */
  mixed: boolean;
}
export interface CopilotPolicyResult extends CopilotIntent {
  /** MESSAGE: the current message alone; CONVERSATION: the message read together with the client-sent history. */
  scope: 'MESSAGE' | 'CONVERSATION';
  /** Allowed, but only on its own: the earlier conversation held a request the copilot does not answer. */
  dropHistory: boolean;
  /** The deterministic answer for a non-ALLOW result. */
  response: { en: string; th: string } | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization: case, width (NFKC), invisible characters, letter-spacing ("f i r e d") and digit look-alikes.
// ---------------------------------------------------------------------------------------------------------------
const INVISIBLE = /[​-‍⁠﻿­]/g;
/** Phrases whose words would otherwise read as a judgment or an inference but are ordinary HR facts. */
const NEUTRAL: [RegExp, string][] = [
  [/\b(?:sick|sickness|medical|maternity|paternity) leaves?\b/g, 'leave-type'],
  [/(?:ลาป่วย|ลาคลอด)/g, 'ลาประเภท'],
  [/\bfire (?:drills?|safety|wardens?|evacuations?|extinguishers?|alarms?|marshals?|exits?|doors?|training)\b/g, 'safety-topic'],
  [/\braise (?:this|it|that|a (?:question|concern|ticket|request|case|issue|point)|an (?:issue|objection)|the (?:issue|matter|question|concern|ticket|request|point)|concerns?|questions?|issues?|tickets?|requests?)\b/g, 'bring-up'],
  [/\b(?:best|right) (?:person|people|contact|team|one) to (?:contact|ask|talk to|reach|email|call)\b/g, 'contact-point'],
  [/\b(?:who|which person) (?:should|do|can|could) (?:i|we) (?:contact|ask|talk to|speak to|reach|email|call)\b/g, 'contact-point'],
];
function normalize(raw: string): string {
  // NFKC folds full-width Latin, but it also splits Thai SARA AM (ำ) into NIKHAHIT + SARA AA; recompose it.
  let t = raw.normalize('NFKC').replace(/\u0E4D\u0E32/g, '\u0E33').replace(INVISIBLE, '').toLowerCase().replace(/[’‘`´]/g, "'");
  t = t.replace(/\b(?:[a-z][ .\-_*]){2,}[a-z]\b/g, (m) => m.replace(/[ .\-_*]/g, ''));
  t = t.replace(/\s+/g, ' ').trim();
  for (const [re, to] of NEUTRAL) t = t.replace(re, to);
  return t;
}
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
const deleet = (t: string) => t.replace(/(?<=[a-z])[013457@$]|[013457@$](?=[a-z])/g, (c) => LEET[c] ?? c);

// ---------------------------------------------------------------------------------------------------------------
// Signals. English uses word boundaries; Thai has no spaces between words, so Thai patterns are substrings.
// ---------------------------------------------------------------------------------------------------------------
const has = (t: string, ...res: RegExp[]) => res.some((r) => r.test(t));

const PERSON = [
  /\b(?:who|whom|whose|which (?:one|ones|person|people|employees?|staff|candidates?|team ?members?|members?|workers?|engineers?|managers?|individuals?|of (?:them|my|our|the|these|those))|employees?|staff(?:ers)?|people|persons?|individuals?|candidates?|team ?members?|subordinates?|direct reports?|workers?|colleagues?|engineers?|someone|somebody|anyone|anybody|him|her|them|he|she|they|my team|our team|the team|names?|emp\d+)\b/,
  /(?:ใคร|คนไหน|คนใด|พนักงาน|ลูกน้อง|ลูกทีม|ผู้สมัคร|บุคคล|รายชื่อ|รายคน|แต่ละคน|คนที่|คนใน|ทีมของฉัน|ทีมฉัน|ในทีม|เขา|เธอ|เค้า|คนนี้|คนนั้น|employee|emp\d)/,
];
const JUDGE = [
  /\b(?:should(?:n'?t)?|ought|deserv\w*|recommend\w*|suggest(?:ion)?s?|advis\w*|decid\w*|decision|choos\w*|chose|pick\w*|select\w*|shortlist\w*|nominat\w*|single out|target\w*|worth|merits?|suitable|fit for|ready for|in line for|would you|if you (?:had|were|have) to|who gets|who goes|who stays|who to|need(?:s)? to (?:be|go)|must (?:be|go)|candidates? for|first in line|hypothetical\w*|pretend\w*|role[- ]?play\w*|imagine|act as|would (?:the|a|our|your) \w+ (?:fire|promote|dismiss|pick|choose|hire|punish))\b/,
  /(?:ควร|สมควร|น่าจะ|เหมาะ|คู่ควร|แนะนำ|ตัดสิน|เลือก|คัดคน|ชี้ตัว|ระบุตัว|ใครได้|ใครจะได้|ต้องโดน|ต้องถูก|ถ้าต้อง|ถ้าคุณเป็น|สมมติ|สวมบทบาท|ตัวเต็ง|ถึงเวลา)/,
];
const RANK = [
  /\b(?:rank\w*|order(?:ed)? by|sort(?:ed)? by|sort\w*|compar\w*|versus|vs|top ?\d*|bottom ?\d*|best|worst|weakest|strongest|highest|lowest|most|least|leaderboard|league table|tier list|stack[- ]rank\w*)\b/,
  /(?:จัดอันดับ|เรียงลำดับ|เรียงตาม|อันดับ|เปรียบเทียบ|ที่สุด|สูงสุด|ต่ำสุด|ท็อป)/,
];
const INFER = [
  /\b(?:infer\w*|likely|unlikely|probabl\w*|possibl\w*|might|may be|maybe|seem\w*|looks?|looking|appear\w*|suspect\w*|suspicious\w*|guess\w*|predict\w*|indicat\w*|prov(?:e|es|ing)|shows?|suggests?|signs? of|based on|judging|deduc\w*|tell (?:me )?(?:if|whether)|from (?:their|the|his|her|our) (?:claims?|expenses?|benefits?|leave|travel|requests?|spending|data|records?))\b/,
  /(?:น่าจะ|อาจจะ|อาจ|คาดว่า|สงสัย|ส่อ|ดูเหมือน|ดูจาก|จากข้อมูล|อนุมาน|เดา|ทำนาย|คาดการณ์|บ่งชี้|แสดงว่า|พิสูจน์|มีแนวโน้ม|เข้าข่าย|ดูออก)/,
];
const PROCESS = [
  /\b(?:process|procedures?|polic(?:y|ies)|rules?|steps?|guidelines?|checklists?|how (?:do|does|to|should|can) (?:we|i|the company|a manager)|explain|define|definition|laws?|legal\w*|requirements?|notice period|severance)\b/,
  /(?:ขั้นตอน|นโยบาย|ระเบียบ|กระบวนการ|กฎหมาย|ข้อบังคับ|หลักเกณฑ์|วิธี|อธิบาย|คืออะไร|ทำอย่างไร|ทำยังไง|เงื่อนไข)/,
];
const FACTUAL_CUE = [
  /\b(?:how many|how much|number of|count|total|sum|average|avg|headcount|summary|summari[sz]e|overview|breakdown|distribution|what (?:is|are|was|were) (?:the|our|my)|by (?:department|currency|month|category|type|status|organization)|list (?:my|our|the)|show (?:my|our|the)|trend|rate|overdue|pending|completed|usage|balance|process|policy|explain)\b/,
  /(?:กี่|จำนวน|ทั้งหมด|รวม|ยอด|สรุป|ภาพรวม|เท่าไร|เท่าไหร่|แยกตาม|ค้าง|headcount|ขั้นตอน|นโยบาย|อธิบาย|คงเหลือ)/,
];
const CONTINUATION = [
  /\b(?:them|those|these|they|their|theirs|that one|the same|above|previous|earlier|continue|go on|the rest|rank\w*|sort\w*|order them|who among|which of)\b/,
  /(?:พวกเขา|พวกนั้น|พวกนี้|เหล่านั้น|เหล่านี้|ข้างบน|ก่อนหน้า|ต่อเลย|ทำต่อ|เมื่อกี้|จัดอันดับ|เรียง|ในนั้น)/,
];

/** Decision objects: these count with a judgment (or a ranking of people). */
const DECISION: [BlockCategory, RegExp[]][] = [
  ['TERMINATION', [
    /\b(?:fir(?:e|ed|ing)|terminat\w*|dismiss\w*|lay ?offs?|laying off|laid off|let (?:\w+ )?go|sack\w*|get rid of|axe|axed|redundan\w*|downsiz\w*|cut loose|kick(?:ed)? out|remov(?:e|ed) from (?:the )?(?:company|team|payroll)|show (?:\w+ )?the door)\b/,
    /(?:ไล่ออก|ไล่.{0,10}ออก|เลิกจ้าง|ให้ออก|ปลดออก|เชิญออก|เอาออก|เลย์ออฟ|ลดคน|ลดพนักงาน|พ้นสภาพ)/,
  ]],
  ['DISCIPLINE', [
    /\b(?:disciplin\w*|punish\w*|written warnings?|warning letters?|warnings?|write(?:-| )?ups?|written up|reprimand\w*|sanction\w*|penali[sz]\w*|suspen(?:d|ded|sion))\b/,
    /(?:ลงโทษ|ตักเตือน|ใบเตือน|หนังสือเตือน|พักงาน|ภาคทัณฑ์|ทัณฑ์บน|วินัย)/,
  ]],
  ['PROMOTION_SELECTION', [
    /\b(?:promot\w*|hire|hiring|hired|reject\w*|successors?|succession|next (?:manager|leader|lead|head)|step up|high[- ]?flyers?|shortlist\w*|offer (?:the|a) (?:job|role|position))\b/,
    /(?:เลื่อนตำแหน่ง|เลื่อนขั้น|โปรโมท|โปรโมต|รับเข้า|(?<!เลิก)จ้าง|ผู้สืบทอด|ทายาท|ตัวตายตัวแทน|คัดเลือก|ปฏิเสธผู้สมัคร|หัวหน้าคนต่อไป|ขึ้นเป็นหัวหน้า)/,
  ]],
  ['COMPENSATION', [
    /\b(?:raises?|pay ?rises?|salary (?:increases?|increments?|raises?|cuts?|reductions?|adjustments?)|increments?|bonus\w*|merit (?:increases?|pay)|pay (?:more|less|cut)|(?:higher|lower|more|less) (?:pay|salary)|compensation (?:increases?|adjustments?|changes?)|remov\w* (?:\w+ )?benefits?|(?:cut|revok\w*|withdraw\w*|take away|strip\w*) (?:\w+ )?(?:benefits?|welfare|allowances?|entitlements?)|(?:benefits?|welfare|allowances?|entitlements?) (?:\w+ )?(?:removed|cut|revoked|taken away|withdrawn))\b/,
    /(?:ขึ้นเงินเดือน|เพิ่มเงินเดือน|ลดเงินเดือน|ปรับเงินเดือน|โบนัส|ขึ้นค่าจ้าง|เงินพิเศษ|(?:ตัด|ยกเลิก|ถอน|ริบ|ลด).{0,10}(?:สวัสดิการ|สิทธิ์เบิก|สิทธิเบิก|เบี้ยเลี้ยง))/,
  ]],
];
const PERF_TERM = [
  /\b(?:perform\w*|ratings?|scores?|scored|weighted ?scores?|kpis?|appraisals?|productiv\w*|competen\w*|skill(?:s|ed)?|output|contribution|efficien\w*|hard[- ]?working|effort)\b/,
  /(?:ผลงาน|ผลการประเมิน|คะแนน|ประสิทธิภาพ|เกรด|kpi|performance|ฝีมือ|ความสามารถ|ขยัน)/,
];
const SUPERLATIVE_PERSON = [
  /\b(?:best|worst|weakest|strongest|laziest|smartest|most (?:valuable|productive|competent|talented|useless|lazy|effective|reliable|unreliable)|least (?:valuable|productive|competent|effective|reliable)) (?:\w+ )?(?:employees?|performers?|staff|people|persons?|workers?|members?|engineers?|managers?|candidates?|one|ones|of (?:them|my|our|the))\b/,
  /\b(?:who|which (?:one|employee|person|candidate))\b.{0,30}\b(?:best|worst|weakest|strongest|laziest|most (?:valuable|productive|competent|talented)|least (?:valuable|productive|competent))\b/,
  /\b(?:top|best|worst|star|high) ?-?performers?\b/,
  /(?:ใคร|คนไหน|พนักงาน|ผู้สมัคร|candidate).{0,30}(?:ดีที่สุด|แย่ที่สุด|เก่งที่สุด|ห่วยที่สุด|ขี้เกียจที่สุด|ขยันที่สุด|อ่อนที่สุด|ไม่เอาไหนที่สุด)/,
];
const SELECTION_SUBJECT = [/\b(?:candidates?|successors?|hires?)\b/, /(?:ผู้สมัคร|ผู้สืบทอด|successor|candidate)/];
const TALENT_TERM = [/\b(?:potential|hi-?pos?|high[- ]potentials?|9[- ]?box|nine[- ]?box|future leaders?|leadership potential|talents?)\b/, /(?:ศักยภาพ|ดาวรุ่ง|ผู้นำในอนาคต|9-box|9 box|nine box|ทาเลนต์|talent)/];
const ATTRITION_TERM = [/\b(?:resign\w*|quit\w*|leav(?:e|ing) the company|attrition|turnover|flight risks?|retention risks?)\b/, /(?:ลาออก|จะออก|ย้ายงาน|เปลี่ยนงาน)/];
const ATTRITION_RISK = [/\b(?:flight|attrition|retention) risks?\b/];

/** Inference topics: these count with a person or an inference cue. */
const INFERENCE: [BlockCategory, RegExp[]][] = [
  ['FRAUD_INFERENCE', [
    /\b(?:fraud\w*|dishonest\w*|cheat\w*|lying|liars?|steal\w*|stole|theft|thie(?:f|ves)|embezzl\w*|abus\w*|misus\w*|padd(?:ing|ed)|inflat\w*|fake (?:claims?|receipts?|expenses?)|untrustworth\w*|trustworth\w*|honest\w*|corrupt\w*|kickbacks?|double[- ]?dip\w*|scam\w*)\b/,
    /(?:ทุจริต|โกง|ซื่อสัตย์|เบิกเกิน|เบิกมั่ว|ยักยอก|ขโมย|ปลอม|คอร์รัปชัน|คอรัปชั่น|เบิกเท็จ|เบิกซ้ำ|ตุกติก)/,
  ]],
  ['HEALTH_INFERENCE', [
    /\b(?:sick|sickness|ill|illness\w*|disease\w*|medical (?:conditions?|history|issues?|problems?)|health (?:conditions?|issues?|problems?|status|risks?)|unhealthy|diagnos\w*|chronic|pregnan\w*|disabilit\w*|disabled|mental health|depress\w*|anxiety|cancer|diabet\w*|addict\w*)\b/,
    /(?:ป่วย|เป็นโรค|โรคประจำตัว|สุขภาพไม่ดี|สุขภาพแย่|ปัญหาสุขภาพ|ตั้งครรภ์|ท้อง(?!ถิ่น)|ซึมเศร้า|พิการ|มะเร็ง|เบาหวาน|ติดยา|ติดเหล้า)/,
  ]],
  ['FINANCIAL_DISTRESS_INFERENCE', [
    /\b(?:financial (?:distress|hardship|trouble|problems?|difficult\w*|stress|situation)s?|financially (?:struggling|stressed|troubled)|money (?:problems?|troubles?|issues?)|in debt|debts?|indebted|(?:is|are|went|going) broke|bankrupt\w*|insolven\w*|loan sharks?|can'?t afford|struggling financially|paycheck to paycheck|cash[- ]strapped|gambl\w*)\b/,
    /(?:ปัญหาการเงิน|ปัญหาทางการเงิน|หนี้|ช็อต|ชักหน้าไม่ถึงหลัง|ขัดสน|ลำบากทางการเงิน|เงินไม่พอ|ล้มละลาย|การพนัน|เล่นพนัน)/,
  ]],
];
const PROFILING = [
  /\b(?:risk ?(?:scores?|profiles?|ratings?|lists?)|profil(?:e|es|ing) (?:of|on|for) (?:each|every|all)|(?:build|create|make|compile|construct)\w* (?:a |an )?(?:\w+ )?(?:profiles?|dossiers?)|dossiers?|profiling|red[- ]?flags?|watch ?lists?|blacklists?|cross[- ]?referenc\w*|correlat\w*|everything (?:about|on)|full picture of|background checks?)\b/,
  /(?:โปรไฟล์ความเสี่ยง|คะแนนความเสี่ยง|ประวัติความเสี่ยง|บัญชีดำ|รวม(?:ข้อมูล)?.{0,20}(?:ทุกด้าน|ทุกเรื่อง|หลายด้าน)|ประวัติทั้งหมด|เช็คประวัติ|ธงแดง|โปรไฟล์.{0,10}(?:ความเสี่ยง|พฤติกรรม))/,
];
const AMBIGUOUS = [
  /\b(?:problem(?:atic)? (?:employees?|staff|people|workers?|members?)|bad (?:employees?|staff|apples?|hires?|people)|trouble ?makers?|under-?performers?|low performers?|poor performers?|dead ?weight|slackers?|lazy (?:employees?|staff|people)|risky (?:employees?|staff|people)|keep an eye on|worry about|not pulling (?:their|his|her) weight|toxic (?:employees?|people|staff)|weak links?|who is a problem|causing (?:problems|trouble))\b/,
  /(?:พนักงานที่มีปัญหา|พนักงานมีปัญหา|คนที่มีปัญหา|คนมีปัญหา|ตัวปัญหา|ใคร.{0,10}มีปัญหา|ใคร.{0,10}ขี้เกียจ|พนักงานแย่|คนไม่ดี|น่าจับตา|ต้องจับตา|พนักงานเสี่ยง|อู้งาน|ตัวถ่วง)/,
];

/** The categories a normalized text asks for; empty when it asks for none. */
function blockedCategories(t: string): BlockCategory[] {
  const person = has(t, ...PERSON);
  const judge = has(t, ...JUDGE);
  const rank = has(t, ...RANK);
  const infer = has(t, ...INFER);
  const process = has(t, ...PROCESS);
  const out: BlockCategory[] = [];
  for (const [cat, res] of DECISION) if (has(t, ...res) && ((judge && (person || !process)) || (rank && person))) out.push(cat);
  if (has(t, ...SUPERLATIVE_PERSON) || (rank && person && has(t, ...PERF_TERM))) {
    const cat: BlockCategory = has(t, ...SELECTION_SUBJECT) ? 'PROMOTION_SELECTION' : 'PERFORMANCE_RANKING';
    if (!out.includes(cat)) out.push(cat);
  }
  if ((has(t, ...TALENT_TERM) && person && (rank || judge)) || (has(t, ...ATTRITION_TERM) && person && (infer || has(t, ...ATTRITION_RISK)))) out.push('TALENT_RANKING');
  const inferred: BlockCategory[] = [];
  for (const [cat, res] of INFERENCE) if (has(t, ...res) && (infer || person)) inferred.push(cat);
  out.push(...inferred);
  const profiling = has(t, ...PROFILING) && (person || inferred.length > 0 || INFERENCE.some(([, res]) => has(t, ...res)));
  if (profiling || inferred.length >= 2) return ['COMBINED_PROFILING', ...out];
  return out;
}
const categoriesOf = (raw: string): BlockCategory[] => {
  const t = normalize(raw);
  const a = blockedCategories(t);
  return a.length ? a : blockedCategories(deleet(t));
};
/** Sentence and conjunction boundaries, to tell a separate factual question inside a blocked message. */
const SEGMENT = /[.?!;\n]+|,? +(?:and also|and then|and|also|then|plus|but) +|และ|แล้วก็|แล้ว|พร้อมทั้ง|ส่วน/;

/** Classify one text (a message, or a window of the conversation). */
export function classifyCopilotIntent(raw: string): CopilotIntent {
  const cats = categoriesOf(raw);
  if (cats.length) {
    const t = normalize(raw);
    const segments = t.split(SEGMENT).map((s) => s.trim()).filter((s) => s.length >= 4);
    const mixed = segments.length > 1 && segments.some((s) => !categoriesOf(s).length && has(s, ...FACTUAL_CUE));
    return { decision: 'BLOCK_HIGH_IMPACT_DECISION', category: cats[0]!, categories: [...new Set(cats)], mixed };
  }
  if (has(normalize(raw), ...AMBIGUOUS)) return { decision: 'CLARIFICATION_REQUIRED', category: 'AMBIGUOUS_PERSON_JUDGMENT', categories: ['AMBIGUOUS_PERSON_JUDGMENT'], mixed: false };
  return { decision: 'ALLOW_FACTUAL_QUERY', category: null, categories: [], mixed: false };
}
/** Kept for callers of the Task 31 helper: true when the text asks for a high-impact decision. */
export const isHighImpactQuestion = (text: string): boolean => classifyCopilotIntent(text).decision === 'BLOCK_HIGH_IMPACT_DECISION';

// ---------------------------------------------------------------------------------------------------------------
// Deterministic responses.
// ---------------------------------------------------------------------------------------------------------------
const LEAD: Record<BlockCategory, { en: string; th: string; altEn: string; altTh: string }> = {
  TERMINATION: { en: 'decide or suggest who should be dismissed or let go', th: 'ตัดสินหรือเสนอว่าใครควรถูกเลิกจ้าง', altEn: 'the documented termination process, or headcount and movement totals', altTh: 'ขั้นตอนการเลิกจ้างที่บริษัทกำหนด หรือจำนวนพนักงานและการเคลื่อนไหวระดับองค์กร' },
  DISCIPLINE: { en: 'decide or suggest who should be disciplined or warned', th: 'ตัดสินหรือเสนอว่าใครควรถูกลงโทษหรือตักเตือน', altEn: 'the disciplinary process, or employee-relations case counts', altTh: 'ขั้นตอนทางวินัย หรือจำนวนเรื่องแรงงานสัมพันธ์ระดับองค์กร' },
  PROMOTION_SELECTION: { en: 'choose, rank or recommend people for promotion, hiring or succession', th: 'เลือก จัดอันดับ หรือแนะนำบุคคลเพื่อเลื่อนตำแหน่ง รับเข้าทำงาน หรือเป็นผู้สืบทอด', altEn: 'succession coverage, the recruitment funnel, or competency gaps against a job', altTh: 'ความครอบคลุมของแผนสืบทอด ภาพรวมการสรรหา หรือช่องว่างสมรรถนะเทียบกับตำแหน่ง' },
  COMPENSATION: { en: 'decide or recommend raises, bonuses, pay or benefits for people', th: 'ตัดสินหรือแนะนำการขึ้นเงินเดือน โบนัส ค่าตอบแทน หรือสวัสดิการของบุคคล', altEn: 'the compensation-planning cycle status and organization-level budget totals', altTh: 'สถานะรอบการพิจารณาค่าตอบแทนและยอดงบประมาณระดับองค์กร' },
  PERFORMANCE_RANKING: { en: 'rank or compare people by performance', th: 'จัดอันดับหรือเปรียบเทียบบุคคลตามผลงาน', altEn: 'review completion and the organization-level rating distribution', altTh: 'ความคืบหน้าการประเมินและการกระจายผลการประเมินระดับองค์กร' },
  TALENT_RANKING: { en: 'rank people by potential or predict who will leave', th: 'จัดอันดับบุคคลตามศักยภาพหรือทำนายว่าใครจะลาออก', altEn: 'succession coverage, the 9-box distribution and the attrition rate', altTh: 'ความครอบคลุมของแผนสืบทอด การกระจาย 9-box และอัตราการลาออก' },
  FRAUD_INFERENCE: { en: 'infer dishonesty or fraud about people from HR data', th: 'อนุมานว่าบุคคลใดทุจริตหรือไม่ซื่อสัตย์จากข้อมูล HR', altEn: 'expense and benefit totals by currency and category, and the approval process', altTh: 'ยอดค่าใช้จ่ายและสวัสดิการแยกตามสกุลเงินและหมวด และขั้นตอนการอนุมัติ' },
  HEALTH_INFERENCE: { en: 'infer health conditions about people from HR data', th: 'อนุมานภาวะสุขภาพของบุคคลจากข้อมูล HR', altEn: 'benefit plan and claim totals at organization level', altTh: 'แผนสวัสดิการและยอดการเบิกระดับองค์กร' },
  FINANCIAL_DISTRESS_INFERENCE: { en: "infer people's financial situation from HR data", th: 'อนุมานสถานะทางการเงินของบุคคลจากข้อมูล HR', altEn: 'organization-level expense, benefit and payroll totals', altTh: 'ยอดค่าใช้จ่าย สวัสดิการ และเงินเดือนระดับองค์กร' },
  COMBINED_PROFILING: { en: 'combine HR data into a profile or risk judgment about people', th: 'รวมข้อมูล HR เพื่อสร้างโปรไฟล์หรือประเมินความเสี่ยงของบุคคล', altEn: 'organization-level summaries for each module separately', altTh: 'สรุประดับองค์กรของแต่ละโมดูลแยกกัน' },
};
const BOUNDARY = {
  en: 'Decisions about hiring, promotion, pay, discipline, dismissal and succession belong to the authorized HR and management process; the copilot does not make, recommend or rank them, and does not infer anything about a person from HR data. No HR data was looked up for this request.',
  th: 'การตัดสินใจเรื่องการจ้าง เลื่อนตำแหน่ง ค่าตอบแทน ลงโทษ เลิกจ้าง และผู้สืบทอด เป็นของกระบวนการ HR และผู้บริหารที่มีอำนาจ Copilot ไม่ตัดสิน ไม่แนะนำ ไม่จัดอันดับ และไม่อนุมานสิ่งใดเกี่ยวกับบุคคลจากข้อมูล HR คำขอนี้ไม่มีการค้นข้อมูล HR ใด ๆ',
};
const EARLIER = { en: 'The request comes from an earlier message in this conversation; ask a self-contained factual question or clear the conversation.', th: 'คำขอนี้มาจากข้อความก่อนหน้าในบทสนทนานี้ กรุณาถามคำถามเชิงข้อเท็จจริงที่สมบูรณ์ในตัว หรือล้างบทสนทนา' };
const MIXED = { en: 'Your message also contains a factual question — ask it on its own and I will answer it.', th: 'ข้อความนี้มีคำถามเชิงข้อเท็จจริงอยู่ด้วย กรุณาถามแยกเป็นคำถามเดียว แล้วฉันจะตอบให้' };
const CLARIFY = {
  en: 'Could you say more precisely what you need? I do not label or single out employees. I can give organization-level facts — overdue reviews, attendance exceptions, open employee-relations case counts or the rating distribution — or the records of a process you are authorized to see. No HR data was looked up for this request.',
  th: 'ช่วยระบุให้ชัดขึ้นได้ไหมว่าต้องการข้อมูลอะไร ฉันไม่ติดป้ายหรือชี้ตัวพนักงาน แต่ให้ข้อเท็จจริงระดับองค์กรได้ เช่น การประเมินที่ค้าง ความผิดปกติด้านการลงเวลา จำนวนเรื่องแรงงานสัมพันธ์ที่เปิดอยู่ หรือการกระจายผลการประเมิน หรือข้อมูลของกระบวนการที่คุณมีสิทธิ์เห็น คำขอนี้ไม่มีการค้นข้อมูล HR ใด ๆ',
};
/** The answer the server returns instead of a model draft that turned facts into a judgment about people. */
export const COPILOT_OUTPUT_WITHHELD = {
  en: `The drafted answer contained a judgment or recommendation about people, so it was withheld. ${BOUNDARY.en.replace(' No HR data was looked up for this request.', '')} Ask for the facts again without asking for a decision.`,
  th: `คำตอบที่ร่างไว้มีการตัดสินหรือคำแนะนำเกี่ยวกับบุคคล จึงไม่แสดง ${BOUNDARY.th.replace(' คำขอนี้ไม่มีการค้นข้อมูล HR ใด ๆ', '')} กรุณาถามเฉพาะข้อเท็จจริงอีกครั้ง`,
};
export const COPILOT_HISTORY_DROPPED = {
  en: 'The earlier conversation contained a request the copilot does not answer, so this question was answered on its own.',
  th: 'บทสนทนาก่อนหน้ามีคำขอที่ Copilot ไม่ตอบ คำถามนี้จึงถูกตอบแยกโดยไม่ใช้บทสนทนาก่อนหน้า',
};
const blockText = (cat: BlockCategory, mixed: boolean, earlier: boolean) => ({
  en: `I can't do that: this request asks me to ${LEAD[cat].en}. ${BOUNDARY.en} I can help with facts you are authorized to see instead — for example ${LEAD[cat].altEn}.${mixed ? ` ${MIXED.en}` : ''}${earlier ? ` ${EARLIER.en}` : ''}`,
  th: `ฉันทำตามคำขอนี้ไม่ได้ เพราะคำขอนี้ให้ฉัน${LEAD[cat].th} ${BOUNDARY.th} ฉันช่วยเรื่องข้อเท็จจริงที่คุณมีสิทธิ์เห็นได้แทน เช่น ${LEAD[cat].altTh}${mixed ? ` ${MIXED.th}` : ''}${earlier ? ` ${EARLIER.th}` : ''}`,
});
/** Every sentence the server itself writes; removed from history before it is classified, so it never poisons a thread. */
const SERVER_TEXT: string[] = [
  ...Object.values(LEAD).flatMap((l) => [`I can't do that: this request asks me to ${l.en}.`, `ฉันทำตามคำขอนี้ไม่ได้ เพราะคำขอนี้ให้ฉัน${l.th}`, `I can help with facts you are authorized to see instead — for example ${l.altEn}.`, `ฉันช่วยเรื่องข้อเท็จจริงที่คุณมีสิทธิ์เห็นได้แทน เช่น ${l.altTh}`]),
  BOUNDARY.en, BOUNDARY.th, MIXED.en, MIXED.th, EARLIER.en, EARLIER.th, CLARIFY.en, CLARIFY.th, COPILOT_OUTPUT_WITHHELD.en, COPILOT_OUTPUT_WITHHELD.th,
  COPILOT_HISTORY_DROPPED.en, COPILOT_HISTORY_DROPPED.th, HIGH_IMPACT_NOTICE.en, HIGH_IMPACT_NOTICE.th,
].sort((a, b) => b.length - a.length);
const stripServerText = (s: string) => SERVER_TEXT.reduce((acc, x) => acc.split(x).join(' '), s).trim();

const responseFor = (r: CopilotIntent, scope: 'MESSAGE' | 'CONVERSATION') =>
  r.decision === 'BLOCK_HIGH_IMPACT_DECISION' ? blockText(r.category as BlockCategory, r.mixed, scope === 'CONVERSATION') : r.decision === 'CLARIFICATION_REQUIRED' ? { ...CLARIFY } : null;

/** How many consecutive turns are read together when looking for a request split across turns. */
const WINDOW = 4;

/**
 * The policy for one request: the current message, then the conversation the provider would see. A request split
 * over several turns ("Who in engineering should be" / "fired?") is read as one; a forged assistant turn is
 * classified like any other text. A self-contained factual question after a blocked turn is answered on its own,
 * without the earlier conversation, so one refused request does not end the thread.
 */
export function evaluateCopilotPolicy(input: { message: string; history: { role: 'user' | 'assistant'; content: string }[] }): CopilotPolicyResult {
  const done = (r: CopilotIntent, scope: 'MESSAGE' | 'CONVERSATION', dropHistory = false): CopilotPolicyResult => ({ ...r, scope, dropHistory, response: responseFor(r, scope) });
  const current = classifyCopilotIntent(input.message);
  if (current.decision === 'BLOCK_HIGH_IMPACT_DECISION') return done(current, 'MESSAGE');
  const turns = [...input.history.map((m) => stripServerText(m.content)).filter(Boolean), input.message];
  let context: CopilotIntent | null = null;
  for (let end = 0; end < turns.length && !context; end += 1) {
    for (let size = 1; size <= WINDOW && size <= end + 1; size += 1) {
      const r = classifyCopilotIntent(turns.slice(end - size + 1, end + 1).join(' '));
      if (r.decision === 'BLOCK_HIGH_IMPACT_DECISION') { context = r; break; }
    }
  }
  if (context) {
    const selfContained = current.decision === 'ALLOW_FACTUAL_QUERY' && has(normalize(input.message), ...FACTUAL_CUE) && !has(normalize(input.message), ...CONTINUATION);
    if (selfContained) return done(current, 'MESSAGE', true);
    return done({ ...context, mixed: false }, 'CONVERSATION');
  }
  return done(current, 'MESSAGE');
}

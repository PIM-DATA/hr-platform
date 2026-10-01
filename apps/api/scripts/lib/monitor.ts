import { statfs, stat } from 'node:fs/promises';
import { backupFreshness, type Freshness } from './backup-set';

/**
 * Task 49 (T44-P1-12) — the local monitoring check behind `npm run ops:monitor-check`.
 *
 * It answers, with an exit code an external scheduler/monitor can alert on: is the API up and ready, is the document
 * store usable with room to write, is there a recent verified backup, and is there room for the next one?
 * It does NOT see PostgreSQL's own disk (that is the database host's / provider's monitoring) and it does not deliver
 * alerts itself — something outside the application must run it and page someone on a non-zero exit.
 */
export interface MonitorConfig {
  apiBaseUrl: string | null; // null = skip the HTTP probes (e.g. run on a host without the API)
  timeoutMs: number;
  documentsRoot: string | null;
  storageHealth: (() => Promise<{ ok: boolean; reason?: string }>) | null;
  backupDir: string | null; // null = backup freshness not checked (only allowed outside production)
  maxBackupAgeHours: number;
  minFreeMb: number;
}
export interface CheckResult { name: string; ok: boolean; detail: Record<string, unknown> }

async function freeMb(dir: string): Promise<number | null> {
  try { const s = await statfs(dir); return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024 / 1024); } catch { return null; }
}

async function probe(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    return { status: res.status, body: (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function runMonitorChecks(cfg: MonitorConfig): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const checks: CheckResult[] = [];

  if (cfg.apiBaseUrl) {
    const base = cfg.apiBaseUrl.replace(/\/$/, '');
    const live = await probe(`${base}/api/v1/health/live`, cfg.timeoutMs);
    checks.push({ name: 'api_live', ok: live.status === 200, detail: { status: live.status } });
    const ready = await probe(`${base}/api/v1/health/ready`, cfg.timeoutMs);
    const d = ready.body?.data ?? {};
    checks.push({ name: 'api_ready', ok: ready.status === 200, detail: { status: ready.status, database: d.database ?? null, documentStorage: d.documentStorage ?? null, documentStorageReason: d.documentStorageReason ?? null } });
  }

  if (cfg.documentsRoot && cfg.storageHealth) {
    const h = await cfg.storageHealth().catch(() => ({ ok: false, reason: 'CHECK_FAILED' }));
    const free = await freeMb(cfg.documentsRoot);
    checks.push({ name: 'document_storage', ok: h.ok, detail: { reason: h.reason ?? null } });
    checks.push({ name: 'document_storage_free_space', ok: free !== null && free >= cfg.minFreeMb, detail: { freeMb: free, minFreeMb: cfg.minFreeMb } });
  }

  if (cfg.backupDir) {
    const f: Freshness = await backupFreshness(cfg.backupDir, cfg.maxBackupAgeHours);
    checks.push({ name: 'backup_freshness', ok: f.ok, detail: { lastSetId: f.setId, completedAt: f.completedAt, ageHours: f.ageHours, maxAgeHours: cfg.maxBackupAgeHours, reason: f.reason } });
    const exists = !!(await stat(cfg.backupDir).catch(() => null));
    const free = exists ? await freeMb(cfg.backupDir) : null;
    checks.push({ name: 'backup_free_space', ok: free !== null && free >= cfg.minFreeMb, detail: { freeMb: free, minFreeMb: cfg.minFreeMb } });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

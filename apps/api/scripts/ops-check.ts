/**
 * Deployment/monitoring smoke (`npm run ops:check`): is the API alive and ready?
 *
 * Unauthenticated by design — it only calls the public probes, so it can run from a deployment pipeline or a monitor
 * without credentials. Exits 0 when healthy and non-zero when not, which is all a scheduler needs.
 */
import { opsLog } from './lib/pg-tools';

const base = (process.env.OPS_CHECK_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`).replace(/\/$/, '');
const timeoutMs = Number(process.env.OPS_CHECK_TIMEOUT_MS ?? 5000);

async function probe(pathname: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${pathname}`, { signal: controller.signal, headers: { accept: 'application/json' } });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const started = Date.now();
  const live = await probe('/api/v1/health/live');
  const ready = await probe('/api/v1/health/ready');
  const healthy = live.ok && ready.ok;
  const version = (ready.body as { data?: { version?: string | null } } | null)?.data?.version ?? null;
  opsLog(healthy ? 'ops_check_healthy' : 'ops_check_unhealthy', {
    target: base, liveStatus: live.status, readyStatus: ready.status, version, durationMs: Date.now() - started,
  });
  process.exit(healthy ? 0 : 1);
}

main().catch((err) => {
  opsLog('ops_check_unhealthy', { target: base, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

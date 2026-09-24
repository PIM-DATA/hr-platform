/**
 * Deployment/monitoring smoke (`npm run ops:check`): is the API alive and ready?
 *
 * Unauthenticated by design — it only calls the public probes, so it can run from a deployment pipeline or a monitor
 * without credentials. Exits 0 when healthy and non-zero when not, which is all a scheduler needs.
 */
import { env } from '../src/config/env';
import { opsLog } from './lib/pg-tools';

/**
 * The port comes from the application's own configuration, so a host whose settings live in an `ENV_FILE` outside the
 * repository is probed where it actually listens. Reading `process.env.PORT` directly would silently fall back to
 * 4000 there — and "healthy" reported about a different process is worse than no check at all.
 * `OPS_CHECK_URL` still overrides everything, for probing through a proxy or from another machine.
 */
const base = (process.env.OPS_CHECK_URL ?? `http://127.0.0.1:${env.PORT}`).replace(/\/$/, '');
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
  // Document storage is reported by the readiness probe: 'ok', 'disabled', or 'unavailable' (which already makes it 503).
  const documentStorage = (ready.body as { data?: { documentStorage?: string } } | null)?.data?.documentStorage ?? 'unknown';
  const copilot = (ready.body as { data?: { copilot?: string } } | null)?.data?.copilot ?? 'unknown';
  opsLog(healthy ? 'ops_check_healthy' : 'ops_check_unhealthy', {
    target: base, liveStatus: live.status, readyStatus: ready.status, version, documentStorage, copilot, durationMs: Date.now() - started,
  });
  process.exit(healthy ? 0 : 1);
}

main().catch((err) => {
  opsLog('ops_check_unhealthy', { target: base, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

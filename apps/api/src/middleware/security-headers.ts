import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

/**
 * Baseline security response headers, implemented in-process rather than pulling in Helmet for ~10 headers.
 *
 * This service answers JSON only, so the CSP can be maximally strict (`default-src 'none'`): nothing is ever loaded
 * from an API response. The FRONTEND is served as static files by the reverse proxy, which owns its headers; the
 * reference configurations in deploy/ carry the verified policy and `npm run ops:verify-web` checks a live deployment.
 *
 * HSTS is only sent in production, where TLS is terminated by the proxy; sending it from a plain-HTTP dev server would
 * pin developers' browsers to https://localhost. The TLS-terminating proxy owns HSTS for the web origin (docs/deployment.md);
 * the API's copy carries the same value and is replaced by the proxy's `Header always set` / `add_header`.
 *
 * Cache policy (Task 46): the API serves nothing but private HR data, health probes and error envelopes, so EVERY API
 * response defaults to `Cache-Control: no-store` — browsers, shared proxies and CDNs must not keep a copy. Routes may
 * set a stricter value (downloads use `private, no-store`), never a weaker one. Static web assets are served by the
 * proxy with their own policy (hashed assets immutable, index.html no-cache).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (env.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

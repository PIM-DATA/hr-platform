import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

/**
 * Baseline security response headers, implemented in-process rather than pulling in Helmet for ~10 headers.
 *
 * This service answers JSON only, so the CSP can be maximally strict (`default-src 'none'`): nothing is ever loaded
 * from an API response. The FRONTEND is served as static files by the platform/reverse proxy and needs its own CSP —
 * that is documented as a gap in docs/production-readiness.md rather than guessed at here, because a wrong CSP either
 * breaks the app or provides false comfort.
 *
 * HSTS is only sent in production, where TLS is terminated by the proxy; sending it from a plain-HTTP dev server would
 * pin developers' browsers to https://localhost.
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
  if (env.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { env } from './config/env';
import { apiRouter } from './routes';
import { healthRouter } from './modules/health/health.routes';
import { requestLogger } from './middleware/request-logger';
import { securityHeaders } from './middleware/security-headers';
import { apiRateLimiter } from './middleware/rate-limit';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { authenticate } from './middleware/auth';
import { csrfGuard } from './middleware/csrf';
import { validateRequestUrl } from './middleware/path-params';

/** Builds the Express app (separated from server.ts so tests can import it with supertest). */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Only trust the number of proxy hops that actually exist: req.ip drives rate limiting and req.protocol drives
  // secure-cookie behaviour, so trusting a header that nothing sets would let a client spoof both.
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(securityHeaders);
  app.use(
    cors({
      // Credentialed session cookies mean the allow-list must be explicit — never "*", never reflect-any-origin.
      origin: (origin, callback) => callback(null, !origin || env.allowedOrigins.includes(origin)),
      credentials: true,
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.use(cookieParser());
  app.use(requestLogger);

  // Probes come first: unauthenticated and exempt from rate limiting so a platform health check is never throttled.
  app.use('/api/v1/health', healthRouter);

  // Order matters: rate limit → resolve session → CSRF guard for mutations → business routes.
  app.use('/api/v1', apiRateLimiter, validateRequestUrl, authenticate, csrfGuard, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { env } from './config/env';
import { apiRouter } from './routes';
import { requestLogger } from './middleware/request-logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { authenticate } from './middleware/auth';
import { csrfGuard } from './middleware/csrf';

/** Builds the Express app (separated from server.ts so tests can import it with supertest). */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // correct req.ip / secure cookies behind a reverse proxy

  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestLogger);

  // Order matters: resolve session → CSRF guard for mutations → business routes.
  app.use('/api/v1', authenticate, csrfGuard, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

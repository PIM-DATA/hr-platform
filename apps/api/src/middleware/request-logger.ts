import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';

/** Attaches a request id (echoed as x-request-id) and logs one line per request. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  const start = process.hrtime.bigint();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: res.locals.user?.id,
    };
    if (res.statusCode >= 500) logger.error(line, 'request failed');
    else if (res.statusCode >= 400) logger.warn(line, 'request rejected');
    else logger.info(line, 'request');
  });
  next();
}

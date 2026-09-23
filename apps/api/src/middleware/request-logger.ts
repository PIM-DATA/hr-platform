import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';

/**
 * A client-supplied correlation id is useful for tracing across a proxy, but it is untrusted input that ends up in a
 * response header and in every log line for the request. Accept it only when it is short and boringly printable
 * (the shape real tracing systems emit); anything else is replaced by a server-generated id rather than rejected,
 * so a malformed header never breaks a legitimate request.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export function safeRequestId(value: unknown): string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

/** Attaches a request id (echoed as x-request-id) and logs one line per request. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = safeRequestId(req.headers['x-request-id']);
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

import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { env } from '../config/env';

/** 404 for unknown API routes (must be mounted after all routers). */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` } });
}

/** Converts every thrown error into the standard { error: { code, message, details } } envelope. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = res.locals.requestId;

  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.') || undefined, message: i.message }));
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details } });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ');
      return res.status(409).json({ error: { code: 'CONFLICT', message: `Duplicate value${target ? ` for ${target}` : ''}` } });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({ error: { code: 'INVALID_REFERENCE', message: 'Referenced record does not exist' } });
    }
  }

  // body-parser JSON syntax error
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }

  logger.error({ err, requestId, url: req.originalUrl }, 'unhandled error');
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: env.isProduction ? 'Internal server error' : (err as Error)?.message ?? 'Internal server error',
      requestId,
    },
  });
}

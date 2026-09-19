import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

type Source = 'body' | 'query' | 'params';

/**
 * Validates one part of the request with a zod schema (backend is the source of truth).
 *  - body   → parsed value replaces req.body
 *  - query  → parsed value stored in res.locals.query   (req.query is read-only in Express 5)
 *  - params → parsed value stored in res.locals.params
 * Zod errors are converted by the error handler into 400 VALIDATION_ERROR.
 */
export function validate(schema: ZodType, source: Source = 'body') {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.parse(req[source]);
    if (source === 'body') req.body = parsed;
    else res.locals[source] = parsed;
    next();
  };
}

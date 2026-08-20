import type { Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, 'bad_request', d);
export const unauthorized = (m = 'Not signed in') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Not allowed') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');

export function sendError(res: Response, err: unknown) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Invalid request',
      code: 'validation_failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error', code: 'internal' });
}

/** Wrap an async route so rejected promises reach the error handler. */
export function route<T extends (...args: any[]) => Promise<any> | any>(handler: T) {
  return async (req: any, res: any, next: any) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      sendError(res, err);
    }
  };
}

/**
 * Application error. Throw from services/controllers; the error-handler
 * middleware turns it into the standard error envelope:
 *   { error: { code, message, details? } }
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: { field?: string; message: string }[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: AppError['details']) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(entity = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${entity} not found`);
  }
  static conflict(message: string, details?: AppError['details']) {
    return new AppError(409, 'CONFLICT', message, details);
  }
}

/**
 * Application error taxonomy.
 *
 * Rules:
 * - `code` is a stable machine-readable identifier the client may branch on.
 * - `message` is safe to show a user; it must never contain secrets, SQL or stack data.
 * - Anything unimplemented or unconfigured throws here instead of returning a fake success.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CSRF_FAILED'
  | 'NOT_CONFIGURED'
  | 'NOT_IMPLEMENTED'
  | 'PROVIDER_ERROR'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, httpStatus: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super('VALIDATION_FAILED', message, 400, details);
  }
}
export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Not allowed') {
    super('FORBIDDEN', message, 403);
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message, 404);
  }
}
export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super('CONFLICT', message, 409);
  }
}
export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message, 429);
  }
}
export class CsrfError extends AppError {
  constructor(message = 'CSRF validation failed') {
    super('CSRF_FAILED', message, 403);
  }
}

/**
 * Thrown by any provider adapter that has no credentials/configuration.
 * This is the honest alternative to a mock: the feature is visibly unavailable.
 */
export class ProviderNotConfiguredError extends AppError {
  constructor(public readonly providerKind: string) {
    super(
      'NOT_CONFIGURED',
      `The ${providerKind} provider is not configured in this environment.`,
      503,
      { providerKind },
    );
  }
}

export class NotImplementedError extends AppError {
  constructor(what: string) {
    super('NOT_IMPLEMENTED', `${what} is not implemented yet.`, 501, { what });
  }
}

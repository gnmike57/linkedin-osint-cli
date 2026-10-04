export class LinkedInError extends Error {
  code: string;
  statusCode?: number;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = 'LinkedInError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AuthError extends LinkedInError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends LinkedInError {
  constructor(message: string) {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends LinkedInError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends LinkedInError {
  retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message, 'RATE_LIMIT', 429);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ValidationError extends LinkedInError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 422);
    this.name = 'ValidationError';
  }
}

export class ServerError extends LinkedInError {
  constructor(message: string, statusCode: number = 500) {
    super(message, 'SERVER_ERROR', statusCode);
    this.name = 'ServerError';
  }
}

export class ChallengeError extends LinkedInError {
  constructor(message: string = 'LinkedIn requires a CAPTCHA or verification challenge. Try refreshing your cookie session.') {
    super(message, 'CHALLENGE_ERROR', 403);
    this.name = 'ChallengeError';
  }
}

export function formatError(error: unknown): { message: string; code: string } {
  if (error instanceof LinkedInError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: 'UNKNOWN_ERROR' };
  }
  return { message: String(error), code: 'UNKNOWN_ERROR' };
}

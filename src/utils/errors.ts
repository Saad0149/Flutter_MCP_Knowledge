export type ErrorCode =
  | 'RepositoryNotFound'
  | 'RepositoryMissing'
  | 'GitError'
  | 'SearchFailed'
  | 'InvalidArguments'
  | 'ConfigError'
  | 'IndexError'
  | 'AnalyzerUnavailable'
  | 'ProjectNotFound'
  | 'NativeBindingError'
  | 'InternalError';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export interface StructuredError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (isStructuredError(error)) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'InternalError',
      message: error.message,
    };
  }

  return {
    code: 'InternalError',
    message: 'An unknown error occurred',
    details: error,
  };
}

function isStructuredError(value: unknown): value is StructuredError {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

export type LogLevel = 'info' | 'warning' | 'error';

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface Logger {
  info(message: string, context?: LogContext): void;
  warning(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

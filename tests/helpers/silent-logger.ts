import type { LogContext, Logger } from '../../src/types/logger.js';

/** No-op logger for unit tests (keeps stderr clean). */
export class SilentLogger implements Logger {
  info(_message: string, _context?: LogContext): void {}
  warning(_message: string, _context?: LogContext): void {}
  error(_message: string, _context?: LogContext): void {}
}

import type { LogContext, LogLevel, Logger } from '../types/logger.js';

/**
 * Structured logger that writes JSON lines to stderr.
 * stdout is reserved for MCP stdio transport.
 */
export class StructuredLogger implements Logger {
  constructor(private readonly service: string = 'flutter-knowledge-mcp') {}

  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  warning(message: string, context?: LogContext): void {
    this.write('warning', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...(context ? { context } : {}),
    };

    // MCP uses stdout for protocol; all logs go to stderr.
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }
}

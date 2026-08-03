import type { StructuredError } from '../utils/errors.js';
import { toStructuredError } from '../utils/errors.js';

export interface ToolSuccess<T> {
  readonly success: true;
  readonly data: T;
}

export interface ToolFailure {
  readonly success: false;
  readonly error: StructuredError;
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export function toolOk<T>(data: T): ToolSuccess<T> {
  return { success: true, data };
}

export function toolFail(error: unknown): ToolFailure {
  return { success: false, error: toStructuredError(error) };
}

/**
 * MCP content wrapper: always returns JSON text so Cursor receives structured data.
 * Errors are returned as isError + structured payload (never raw exceptions).
 */
export function toMcpContent<T>(result: ToolResult<T>): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    ...(result.success ? {} : { isError: true }),
  };
}

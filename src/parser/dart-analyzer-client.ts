import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject, injectable } from 'tsyringe';
import type { InsertSymbolInput, SymbolKind } from '../store/types.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { AppError } from '../utils/errors.js';

export interface AnalyzerSymbol {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly isWidget: boolean;
  readonly docstring: string | null;
  readonly packageName: string | null;
  readonly extendsClause: string | null;
  readonly withClause: string | null;
  readonly implementsClause: string | null;
}

export interface AnalyzerFileResult {
  readonly path: string;
  readonly symbols: readonly AnalyzerSymbol[];
}

export interface AnalyzerRunResult {
  readonly available: boolean;
  readonly files: readonly AnalyzerFileResult[];
  readonly warning?: string;
}

const KIND_MAP = {
  class: 'class',
  mixin: 'mixin',
  enum: 'enum',
  extension: 'extension',
  typedef: 'typedef',
  function: 'function',
  method: 'method',
  ctor: 'constructor',
} as const satisfies Record<string, SymbolKind>;

function mapKind(kind: string): SymbolKind {
  if (kind === 'constructor') {
    return 'constructor';
  }
  const mapped = KIND_MAP[kind as keyof typeof KIND_MAP];
  return mapped ?? 'other';
}

/**
 * Spawns the Dart package:analyzer helper when available.
 * Callers must fall back to heuristics when available=false.
 */
@injectable()
export class DartAnalyzerClient {
  constructor(@inject(TYPES.Logger) private readonly logger: Logger) {}

  getHelperPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/parser → ../../parser/bin ; src/parser → ../../parser/bin
    return path.resolve(here, '../../parser/bin/extract_symbols.dart');
  }

  async isAvailable(): Promise<boolean> {
    try {
      await access(this.getHelperPath());
    } catch {
      return false;
    }

    return new Promise((resolve) => {
      const child = spawn('dart', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  async analyzeFiles(
    root: string,
    relativePaths: readonly string[],
  ): Promise<AnalyzerRunResult> {
    if (relativePaths.length === 0) {
      return { available: true, files: [] };
    }

    const available = await this.isAvailable();
    if (!available) {
      this.logger.warning('Dart analyzer helper unavailable; use heuristics', {
        helper: this.getHelperPath(),
      });
      return {
        available: false,
        files: [],
        warning: 'Dart SDK or parser helper not available',
      };
    }

    const payload = JSON.stringify({
      root,
      files: relativePaths,
    });

    try {
      const stdout = await this.runHelper(payload);
      const parsed = JSON.parse(stdout) as {
        files?: AnalyzerFileResult[];
        error?: string;
      };

      if (parsed.error) {
        throw new AppError('AnalyzerUnavailable', parsed.error);
      }

      return {
        available: true,
        files: parsed.files ?? [],
      };
    } catch (error) {
      this.logger.warning('Dart analyzer run failed', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        available: false,
        files: [],
        warning: error instanceof Error ? error.message : String(error),
      };
    }
  }

  toInsertSymbols(
    fileId: number,
    symbols: readonly AnalyzerSymbol[],
  ): InsertSymbolInput[] {
    return symbols.map((symbol) => ({
      fileId,
      name: symbol.name,
      kind: mapKind(symbol.kind),
      line: symbol.line,
      isWidget: symbol.isWidget,
      docstring: symbol.docstring,
      packageName: symbol.packageName,
      extendsClause: symbol.extendsClause,
      withClause: symbol.withClause,
      implementsClause: symbol.implementsClause,
    }));
  }

  private runHelper(stdinPayload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('dart', ['run', this.getHelperPath()], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `dart helper exited with code ${code}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.write(stdinPayload);
      child.stdin.end();
    });
  }
}

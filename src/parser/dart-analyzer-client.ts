import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject, injectable } from 'tsyringe';
import type { AppConfig } from '../config/schema.js';
import type { InsertSymbolInput, SymbolKind } from '../store/types.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { AppError } from '../utils/errors.js';
import { locateDartExecutable, type DartLocateResult } from './dart-sdk-locator.js';

/**
 * Must stay in sync with `jsonMarker` in parser/bin/extract_symbols.dart.
 * Some Dart SDK versions print preamble text straight to stdout ahead of a
 * script's own output (e.g. "Running build hooks..." from the native-assets
 * feature) with no reliable line-ending to split on. Anchoring on our own
 * unique marker — always the last thing printed before our JSON — is immune
 * to whatever Dart's tooling decides to print first, on any SDK version.
 */
const JSON_MARKER = '@@FLUTTER_KNOWLEDGE_JSON@@';

function extractJsonPayload(stdout: string): string {
  const markerIndex = stdout.lastIndexOf(JSON_MARKER);
  if (markerIndex === -1) {
    return stdout;
  }
  return stdout.slice(markerIndex + JSON_MARKER.length);
}

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
  /** Memoized so we only walk the filesystem/PATH once per server process. */
  private locateResult: DartLocateResult | null = null;

  constructor(
    @inject(TYPES.Config) private readonly config: AppConfig,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {
    // Captured once at construction time so we can see exactly what PATH this
    // process (and therefore any subprocess it spawns) actually inherited —
    // this is the value an MCP client's env config would need to affect.
    this.logger.info('DartAnalyzerClient initialized', {
      detectionMethod: 'startup_snapshot',
      platform: process.platform,
      processEnvPath: process.env.PATH ?? '(unset)',
      processEnvPathIsUndefined: process.env.PATH === undefined,
      configuredDartSdkPath: this.config.dartSdkPath ?? null,
    });
  }

  getHelperPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/parser → ../../parser/bin ; src/parser → ../../parser/bin
    return path.resolve(here, '../../parser/bin/extract_symbols.dart');
  }

  /**
   * Resolves the Dart executable without solely relying on inherited PATH:
   * config override → common known install locations (incl. fvm) → PATH lookup.
   * Result is memoized and also used by the `check_environment` tool.
   */
  async locate(): Promise<DartLocateResult> {
    if (this.locateResult) {
      return this.locateResult;
    }

    const result = await locateDartExecutable({ configuredPath: this.config.dartSdkPath });

    if (result.execPath) {
      this.logger.info('Dart executable located', {
        detectionMethod: result.method,
        resolvedPath: result.execPath,
        attemptCount: result.attempts.length,
      });
    } else {
      this.logger.warning('Dart executable not found by any detection method', {
        detectionMethod: 'not_found',
        attempts: result.attempts,
        fellBackToHeuristic: true,
        hint: 'Set "dartSdkPath" in config.json, or install Dart at one of the checked known locations, or ensure PATH is forwarded to this process.',
      });
    }

    this.locateResult = result;
    return result;
  }

  async isAvailable(): Promise<boolean> {
    const helperPath = this.getHelperPath();
    try {
      await access(helperPath);
    } catch (error) {
      this.logger.warning('Dart analyzer helper script not found on disk', {
        detectionMethod: 'helper_script_access_check',
        helperPath,
        error: error instanceof Error ? error.message : String(error),
        fellBackToHeuristic: true,
      });
      return false;
    }

    const located = await this.locate();
    if (!located.execPath) {
      return false;
    }

    const args = ['--version'];

    this.logger.info('Attempting Dart detection by invoking the resolved executable', {
      detectionMethod: located.method,
      command: located.execPath,
      args,
      fullCommand: `${located.execPath} ${args.join(' ')}`,
      cwd: process.cwd(),
    });

    return new Promise((resolve) => {
      const child = spawn(located.execPath as string, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        this.logger.warning('Resolved Dart executable failed to spawn', {
          detectionMethod: located.method,
          command: located.execPath,
          args,
          errorCode: (error as NodeJS.ErrnoException).code ?? null,
          errorMessage: error.message,
          fellBackToHeuristic: true,
        });
        resolve(false);
      });

      child.on('close', (code) => {
        const success = code === 0;
        this.logger.info('Dart detection via resolved executable completed', {
          detectionMethod: located.method,
          command: located.execPath,
          args,
          exitCode: code,
          stderr: stderr.trim() || null,
          success,
          fellBackToHeuristic: !success,
        });
        resolve(success);
      });
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
      const { stdout, stderr } = await this.runHelper(payload);
      const jsonPayload = extractJsonPayload(stdout).trim();

      let parsed: { files?: AnalyzerFileResult[]; error?: string };
      try {
        parsed = JSON.parse(jsonPayload) as { files?: AnalyzerFileResult[]; error?: string };
      } catch (parseError) {
        // JSON.parse's own SyntaxError message is deliberately truncated by V8 to
        // ~10 chars of context — not enough to diagnose what actually printed to
        // stdout. Surface the full raw output ourselves instead of losing it to
        // that truncation. (extractJsonPayload already strips anything before our
        // own JSON_MARKER, e.g. Dart's "Running build hooks..." preamble noise —
        // this branch means even that didn't produce valid JSON.)
        throw new Error(
          `Dart analyzer helper exited 0 but stdout was not valid JSON (${
            parseError instanceof Error ? parseError.message : String(parseError)
          }). Raw stdout (${stdout.length} chars): ${truncateForLog(stdout)}` +
            (stderr.trim() ? ` | stderr: ${truncateForLog(stderr)}` : ''),
        );
      }

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

  /**
   * Actually runs the analyzer helper end-to-end against a throwaway sample
   * file. `isAvailable()` alone only proves `dart --version` works — it does
   * NOT prove `dart run parser/bin/extract_symbols.dart` works, and those can
   * diverge (helper package deps unresolved, analyzer crash, SDK mismatch
   * between the resolved `dart` and the one used for `dart pub get` in
   * `parser/`). This is what `check_environment` should trust, not isAvailable().
   */
  async verifyHelperEndToEnd(): Promise<{ ok: boolean; error?: string }> {
    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'flutter-knowledge-dart-check-'));
      await writeFile(
        path.join(tempDir, 'probe.dart'),
        'class _EnvironmentCheckProbe {\n  void run() {}\n}\n',
        'utf8',
      );

      const result = await this.analyzeFiles(tempDir, ['probe.dart']);
      if (!result.available) {
        return { ok: false, error: result.warning ?? 'Dart analyzer helper run failed' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
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

  private runHelper(stdinPayload: string): Promise<{ stdout: string; stderr: string }> {
    const dartExecPath = this.locateResult?.execPath ?? 'dart';
    return new Promise((resolve, reject) => {
      const child = spawn(dartExecPath, ['run', this.getHelperPath()], {
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
          reject(
            new Error(
              `dart helper exited with code ${code}` +
                (stderr.trim() ? `: ${truncateForLog(stderr)}` : '') +
                (stdout.trim() ? ` | stdout: ${truncateForLog(stdout)}` : ''),
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      });

      child.stdin.write(stdinPayload);
      child.stdin.end();
    });
  }
}

/** Keeps diagnostic errors readable while still showing enough to actually debug. */
function truncateForLog(text: string, maxLength = 500): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return JSON.stringify(trimmed);
  }
  return `${JSON.stringify(trimmed.slice(0, maxLength))}... (truncated, ${trimmed.length} chars total)`;
}

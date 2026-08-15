import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { DartAnalyzerClient } from '../parser/dart-analyzer-client.js';
import { isLikelyUnresolvedAnalyzerDependency } from '../parser/dart-analyzer-client.js';
import type { DartLocateAttempt, DartLocateMethod } from '../parser/dart-sdk-locator.js';
import type { RepositoryManager } from '../repository/types.js';
import type { KnowledgeStore } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const CheckEnvironmentInputSchema = z.object({});

export interface CheckEnvironmentData {
  readonly dart: {
    readonly found: boolean;
    readonly method: DartLocateMethod;
    readonly path: string | null;
    readonly versionCheckPassed: boolean;
    /**
     * Whether `dart run parser/bin/extract_symbols.dart` actually succeeds —
     * the real code path review_project depends on. This can be false even
     * when versionCheckPassed is true (e.g. helper package deps unresolved,
     * analyzer crash) — that gap is exactly what silently degrades analysis
     * to heuristic mode while `dart --version` looks fine.
     */
    readonly helperRunOk: boolean;
    readonly helperError?: string;
    /**
     * Set when helperRunOk is false and the failure looks specifically like
     * the analyzer helper's own pub dependencies (package:analyzer,
     * package:path) were never resolved — e.g. a fresh npm install where
     * scripts/postinstall.mjs's `dart pub get` was skipped (Dart not found
     * at install time) or failed (no network at install time). Distinct
     * from "Dart itself isn't found/working" (see `found`/`versionCheckPassed`
     * above) and from other helper failures (analyzer crash, SDK mismatch).
     */
    readonly helperFailureReason?: 'analyzer_package_unresolved' | 'other';
    readonly attempts: readonly DartLocateAttempt[];
    readonly hint?: string;
  };
  readonly node: {
    readonly version: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly sqlite: {
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly repositories: {
    readonly total: number;
    readonly clonedCount: number;
    readonly missingCount: number;
    readonly missing: readonly string[];
  };
  readonly overallOk: boolean;
  readonly summary: readonly string[];
}

/**
 * Self-diagnostic tool: one call to see exactly why analysis might be running
 * in degraded/heuristic mode, without walking through a multi-message debug
 * session. Covers the two known silent-failure modes (Dart PATH resolution,
 * SQLite native binding) plus repo readiness.
 */
@injectable()
export class CheckEnvironmentHandler {
  constructor(
    @inject(TYPES.DartAnalyzerClient) private readonly dartAnalyzer: DartAnalyzerClient,
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.RepositoryManager) private readonly repositories: RepositoryManager,
  ) {}

  async execute(): Promise<ToolResult<CheckEnvironmentData>> {
    try {
      const located = await this.dartAnalyzer.locate();
      const versionCheckPassed = located.execPath !== null && (await this.dartAnalyzer.isAvailable());
      const helperCheck = versionCheckPassed
        ? await this.dartAnalyzer.verifyHelperEndToEnd()
        : { ok: false, error: undefined };
      const dartOk = located.execPath !== null && versionCheckPassed && helperCheck.ok;

      let sqliteOk = true;
      let sqliteError: string | undefined;
      try {
        this.store.getStats();
      } catch (error) {
        sqliteOk = false;
        sqliteError = error instanceof Error ? error.message : String(error);
      }

      const repoStatuses = await this.repositories.getStatus();
      const missing = repoStatuses.filter((r) => !r.exists).map((r) => r.name);

      const unresolvedAnalyzerDep =
        !helperCheck.ok && isLikelyUnresolvedAnalyzerDependency(helperCheck.error);
      const helperFailureReason: 'analyzer_package_unresolved' | 'other' | undefined = helperCheck.ok
        ? undefined
        : unresolvedAnalyzerDep
          ? 'analyzer_package_unresolved'
          : 'other';

      const dartSummaryLine = (): string => {
        if (dartOk) {
          return `Dart found via ${located.method} at ${located.execPath}, and the analyzer helper runs successfully end-to-end.`;
        }
        if (!located.execPath) {
          return 'Dart not found by any detection method. Set "dartSdkPath" in config.json, install Dart at a common location, or fix PATH forwarding for this server process. Analysis will run in reduced-confidence heuristic mode until this is fixed.';
        }
        if (!versionCheckPassed) {
          return `Dart binary found at ${located.execPath} (via ${located.method}) but failed to execute — check permissions or architecture mismatch.`;
        }
        if (unresolvedAnalyzerDep) {
          return (
            `Dart found and runs at ${located.execPath}, but the analyzer helper's own dependencies (the ` +
            `"analyzer" package) were never resolved — no pubspec.lock/.dart_tool for parser/ yet. This is ` +
            `expected right after a fresh install if Dart wasn't found or there was no network when this ` +
            `package's postinstall step ran (it runs "dart pub get" automatically when it can). Fix: run ` +
            `"dart pub get" inside this installed package's parser/ directory now that Dart/network are ` +
            `available, then call check_environment again to confirm — no need to reinstall.`
          );
        }
        return `Dart found and runs at ${located.execPath}, but the analyzer helper (parser/bin/extract_symbols.dart) failed: ${helperCheck.error}. This is why analysis falls back to heuristic mode even though Dart itself works — check that "cd parser && dart pub get" has been run for this server, and that the error above isn't an analyzer/SDK mismatch.`;
      };

      const summary: string[] = [
        dartSummaryLine(),
        sqliteOk
          ? 'SQLite native binding loaded and responding.'
          : `SQLite native binding failed: ${sqliteError}. Try "npm rebuild better-sqlite3" (native binding likely built for a different Node/OS/arch).`,
        missing.length === 0
          ? `All ${repoStatuses.length} knowledge-base repositories are present.`
          : `${missing.length} of ${repoStatuses.length} knowledge-base repositories are missing: ${missing.join(', ')}. Run update_repositories then reindex.`,
      ];

      return toolOk({
        dart: {
          found: located.execPath !== null,
          method: located.method,
          path: located.execPath,
          versionCheckPassed,
          helperRunOk: helperCheck.ok,
          helperError: helperCheck.error,
          helperFailureReason,
          attempts: located.attempts,
          hint: dartOk
            ? undefined
            : unresolvedAnalyzerDep
              ? 'Run "dart pub get" inside this installed package\'s parser/ directory (Dart/network must be available), then retry — this normally happens automatically on install via postinstall.'
              : located.execPath && versionCheckPassed
                ? 'Dart itself works, but the analyzer helper does not — run "cd parser && dart pub get" for this server, then retry.'
                : 'Install the Dart SDK, or set "dartSdkPath" in config.json to its full path (e.g. "/Users/you/Documents/flutter/bin/dart").',
        },
        node: {
          version: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        sqlite: { ok: sqliteOk, error: sqliteError },
        repositories: {
          total: repoStatuses.length,
          clonedCount: repoStatuses.length - missing.length,
          missingCount: missing.length,
          missing,
        },
        overallOk: dartOk && sqliteOk,
        summary,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

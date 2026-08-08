import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import type { RepositoryManager, RepositoryStatus } from '../../../src/repository/types.js';
import { CheckEnvironmentHandler } from '../../../src/tools/check-environment.js';
import { createSqliteKnowledgeStore, SqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import type { KnowledgeStore } from '../../../src/store/types.js';
import { AppError } from '../../../src/utils/errors.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';

function fakeRepoStatus(name: string, exists: boolean): RepositoryStatus {
  return {
    name,
    exists,
    path: `/repos/${name}`,
    branch: exists ? 'main' : null,
    commit: exists ? 'abc123' : null,
    lastPull: exists ? new Date().toISOString() : null,
  };
}

describe('CheckEnvironmentHandler', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('reports overallOk=true when Dart, SQLite, and repos are all healthy', async () => {
    tempDir = await createTempDir('check-env-ok-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'ok.sqlite'));

    const dartAnalyzer = {
      locate: vi.fn().mockResolvedValue({
        execPath: '/opt/homebrew/bin/dart',
        method: 'known_location',
        attempts: [{ method: 'known_location', candidate: '/opt/homebrew/bin/dart', ok: true }],
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      verifyHelperEndToEnd: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as DartAnalyzerClient;

    const repositories = {
      getStatus: vi.fn().mockResolvedValue([fakeRepoStatus('flutter/flutter', true)]),
    } as unknown as RepositoryManager;

    const handler = new CheckEnvironmentHandler(dartAnalyzer, store, repositories);
    const result = await handler.execute();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dart.found).toBe(true);
      expect(result.data.dart.method).toBe('known_location');
      expect(result.data.dart.path).toBe('/opt/homebrew/bin/dart');
      expect(result.data.dart.helperRunOk).toBe(true);
      expect(result.data.sqlite.ok).toBe(true);
      expect(result.data.repositories.missingCount).toBe(0);
      expect(result.data.overallOk).toBe(true);
      expect(result.data.node.version).toBe(process.version);
    }

    store.close();
  });

  it('reports helperRunOk=false when dart --version passes but the analyzer helper itself fails', async () => {
    tempDir = await createTempDir('check-env-helper-fail-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'helperfail.sqlite'));

    const dartAnalyzer = {
      locate: vi.fn().mockResolvedValue({
        execPath: '/Users/saadhassan/Documents/flutter/bin/dart',
        method: 'known_location',
        attempts: [],
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      verifyHelperEndToEnd: vi.fn().mockResolvedValue({
        ok: false,
        error: 'dart helper exited with code 1: Because flutter_knowledge_parser depends on analyzer...',
      }),
    } as unknown as DartAnalyzerClient;

    const repositories = {
      getStatus: vi.fn().mockResolvedValue([fakeRepoStatus('flutter/flutter', true)]),
    } as unknown as RepositoryManager;

    const handler = new CheckEnvironmentHandler(dartAnalyzer, store, repositories);
    const result = await handler.execute();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dart.found).toBe(true);
      expect(result.data.dart.versionCheckPassed).toBe(true);
      expect(result.data.dart.helperRunOk).toBe(false);
      expect(result.data.dart.helperError).toContain('flutter_knowledge_parser');
      expect(result.data.dart.hint).toMatch(/dart pub get/);
      expect(result.data.overallOk).toBe(false);
      expect(result.data.summary[0]).toMatch(/analyzer helper/);
      // This message doesn't match the specific unresolved-dependency
      // signature (see the dedicated test below) — must not be
      // misclassified as that more specific case.
      expect(result.data.dart.helperFailureReason).toBe('other');
    }

    store.close();
  });

  it('reports dart.helperFailureReason="analyzer_package_unresolved" specifically for the fresh-install postinstall failure mode', async () => {
    tempDir = await createTempDir('check-env-unresolved-dep-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'unresolveddep.sqlite'));

    const dartAnalyzer = {
      locate: vi.fn().mockResolvedValue({
        execPath: '/opt/homebrew/bin/dart',
        method: 'known_location',
        attempts: [],
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      // Real captured error shape (see tests/unit/parser/dart-analyzer-client.test.ts) —
      // parser/'s own pub dependencies were never resolved.
      verifyHelperEndToEnd: vi.fn().mockResolvedValue({
        ok: false,
        error:
          "dart helper exited with code 254: \"Got socket error trying to find package analyzer at " +
          "http://127.0.0.1:1.\\nError: Couldn't resolve the package 'analyzer' in " +
          "'package:analyzer/dart/analysis/analysis_context_collection.dart'.\"",
      }),
    } as unknown as DartAnalyzerClient;

    const repositories = {
      getStatus: vi.fn().mockResolvedValue([fakeRepoStatus('flutter/flutter', true)]),
    } as unknown as RepositoryManager;

    const handler = new CheckEnvironmentHandler(dartAnalyzer, store, repositories);
    const result = await handler.execute();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dart.found).toBe(true);
      expect(result.data.dart.versionCheckPassed).toBe(true);
      expect(result.data.dart.helperRunOk).toBe(false);
      expect(result.data.dart.helperFailureReason).toBe('analyzer_package_unresolved');
      // The summary/hint must be specific — not the generic "helper failed" text.
      expect(result.data.summary[0]).toMatch(/never resolved/);
      expect(result.data.summary[0]).toMatch(/dart pub get/);
      expect(result.data.dart.hint).toMatch(/dart pub get/);
      expect(result.data.dart.hint).toMatch(/parser/);
      expect(result.data.overallOk).toBe(false);
    }

    store.close();
  });

  it('reports dart.found=false and a hint when no detection method locates Dart', async () => {
    tempDir = await createTempDir('check-env-nodart-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'nodart.sqlite'));

    const dartAnalyzer = {
      locate: vi.fn().mockResolvedValue({
        execPath: null,
        method: 'not_found',
        attempts: [{ method: 'path_lookup', candidate: '/usr/bin/dart', ok: false }],
      }),
      isAvailable: vi.fn().mockResolvedValue(false),
    } as unknown as DartAnalyzerClient;

    const repositories = {
      getStatus: vi.fn().mockResolvedValue([fakeRepoStatus('flutter/flutter', true)]),
    } as unknown as RepositoryManager;

    const handler = new CheckEnvironmentHandler(dartAnalyzer, store, repositories);
    const result = await handler.execute();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dart.found).toBe(false);
      expect(result.data.dart.hint).toMatch(/dartSdkPath/);
      expect(result.data.overallOk).toBe(false);
      expect(result.data.summary[0]).toMatch(/Dart not found/);
    }

    store.close();
  });

  it('reports sqlite.ok=false with the underlying error when the store throws', async () => {
    const dartAnalyzer = {
      locate: vi.fn().mockResolvedValue({
        execPath: '/usr/local/bin/dart',
        method: 'known_location',
        attempts: [],
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      verifyHelperEndToEnd: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as DartAnalyzerClient;

    const brokenStore = {
      getStats: vi.fn().mockImplementation(() => {
        throw new Error('disk I/O error');
      }),
    } as unknown as KnowledgeStore;

    const repositories = {
      getStatus: vi.fn().mockResolvedValue([]),
    } as unknown as RepositoryManager;

    const handler = new CheckEnvironmentHandler(dartAnalyzer, brokenStore, repositories);
    const result = await handler.execute();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sqlite.ok).toBe(false);
      expect(result.data.sqlite.error).toContain('disk I/O error');
      expect(result.data.overallOk).toBe(false);
    }
  });

  it('reports a clear, actionable sqlite.ok=false message for the ABI-mismatch/native-binding failure mode specifically', async () => {
    // This is what container.ts registers when SqliteKnowledgeStore fails to
    // open at server startup (see openKnowledgeStoreOrDegrade): the same
    // store class, unopened, carrying the real failure reason — so
    // check_environment can diagnose the exact thing that would otherwise
    // have been an unexplained startup crash.
    const startupFailure = new AppError(
      'NativeBindingError',
      "better-sqlite3's native database binding failed to load. This almost always means the installed " +
        'native binary was built for a different Node.js version, operating system, or CPU architecture than ' +
        'the one currently running this server. Fix: run "npm rebuild better-sqlite3" in the server\'s ' +
        'directory (or delete node_modules and run npm install again), then restart the server. ' +
        'Original error: dlopen failed: incompatible architecture',
      { likelyAbiMismatch: true },
    );
    const degradedStore = new SqliteKnowledgeStore('/irrelevant/path.sqlite', startupFailure);

    const dartAnalyzer = {
      locate: vi.fn().mockResolvedValue({
        execPath: '/usr/local/bin/dart',
        method: 'known_location',
        attempts: [],
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      verifyHelperEndToEnd: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as DartAnalyzerClient;

    const repositories = {
      getStatus: vi.fn().mockResolvedValue([]),
    } as unknown as RepositoryManager;

    const handler = new CheckEnvironmentHandler(dartAnalyzer, degradedStore, repositories);
    const result = await handler.execute();

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.sqlite.ok).toBe(false);
    expect(result.data.overallOk).toBe(false);

    // The message must be actionable to someone who has never heard of
    // better-sqlite3 or an "ABI mismatch": it should name the concrete
    // symptom class (Node version/OS/architecture mismatch) and the exact
    // command that fixes it, not just an opaque native error string.
    const message = result.data.sqlite.error ?? '';
    expect(message).toMatch(/different Node\.js version|operating system|architecture/i);
    expect(message).toContain('npm rebuild better-sqlite3');

    // The top-level summary line (what a caller sees first) also carries
    // the same actionable fix, not just "SQLite native binding failed".
    const sqliteSummaryLine = result.data.summary.find((line) => /sqlite/i.test(line));
    expect(sqliteSummaryLine).toBeDefined();
    expect(sqliteSummaryLine).toContain('npm rebuild better-sqlite3');
  });

  it('reports missing repositories by name', async () => {
    tempDir = await createTempDir('check-env-repos-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'repos.sqlite'));

    const dartAnalyzer = {
      locate: vi.fn().mockResolvedValue({
        execPath: '/usr/local/bin/dart',
        method: 'known_location',
        attempts: [],
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      verifyHelperEndToEnd: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as DartAnalyzerClient;

    const repositories = {
      getStatus: vi.fn().mockResolvedValue([
        fakeRepoStatus('flutter/flutter', true),
        fakeRepoStatus('flutter/samples', false),
      ]),
    } as unknown as RepositoryManager;

    const handler = new CheckEnvironmentHandler(dartAnalyzer, store, repositories);
    const result = await handler.execute();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repositories.total).toBe(2);
      expect(result.data.repositories.clonedCount).toBe(1);
      expect(result.data.repositories.missing).toEqual(['flutter/samples']);
    }

    store.close();
  });
});

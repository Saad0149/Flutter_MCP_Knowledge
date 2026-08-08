import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SqliteKnowledgeStore,
  createSqliteKnowledgeStore,
  isLikelyNativeBindingError,
  wrapNativeBindingError,
} from '../../../src/store/sqlite-store.js';
import { AppError } from '../../../src/utils/errors.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';

/**
 * Real ABI-mismatch errors are awkward to reproduce for real in a test (it
 * would require an actually-mismatched native binary). These are the exact
 * message shapes Node's native module loader (and better-sqlite3's own
 * node-gyp-build-style loader) are documented/known to throw for this
 * failure class — simulating the error SHAPE rather than the native crash
 * itself, per the classification logic this module actually runs.
 */
const REAL_ABI_MISMATCH_MESSAGES = [
  'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.',
  'dlopen(/path/to/better_sqlite3.node, 0x0001): tried: (mach-o file, but is an incompatible architecture (have (x86_64), need (arm64e)))',
  '%1 is not a valid Win32 application.',
  "Cannot find module '/path/to/prebuilds/darwin-arm64.node'",
];

describe('isLikelyNativeBindingError / wrapNativeBindingError — classification of real error shapes', () => {
  it.each(REAL_ABI_MISMATCH_MESSAGES)('recognizes: %s', (message) => {
    expect(isLikelyNativeBindingError(new Error(message))).toBe(true);
  });

  it('does not misclassify an unrelated error as an ABI mismatch', () => {
    expect(isLikelyNativeBindingError(new Error('disk I/O error'))).toBe(false);
  });

  it('produces a structured NativeBindingError whose message a newcomer can act on', () => {
    const original = new Error(REAL_ABI_MISMATCH_MESSAGES[0]);
    const wrapped = wrapNativeBindingError(original, 'load');

    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.code).toBe('NativeBindingError');
    // Explains what's wrong in plain terms, not just jargon...
    expect(wrapped.message).toMatch(/different Node\.js version|architecture/i);
    // ...and gives the exact fix.
    expect(wrapped.message).toContain('npm rebuild better-sqlite3');
    expect(wrapped.details).toMatchObject({ likelyAbiMismatch: true });
  });

  it('still gives the rebuild fix for an unrecognized failure shape, just without claiming certainty', () => {
    const wrapped = wrapNativeBindingError(new Error('disk I/O error'), 'open');
    expect(wrapped.code).toBe('NativeBindingError');
    expect(wrapped.message).toContain('npm rebuild better-sqlite3');
    expect(wrapped.details).toMatchObject({ likelyAbiMismatch: false });
  });
});

describe('SqliteKnowledgeStore — open() failure handling', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.doUnmock('../../../src/store/native-binding-precheck.js');
    vi.resetModules();
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('SECURITY/ROBUSTNESS: a failed pre-check throws a clear AppError WITHOUT ever calling require("better-sqlite3")', async () => {
    tempDir = await createTempDir('sqlite-precheck-fail-');

    vi.resetModules();
    vi.doMock('../../../src/store/native-binding-precheck.js', () => ({
      checkBetterSqlite3PrebuildAvailable: () => ({
        ok: false,
        reason: 'No prebuilt better-sqlite3 binary found for "darwin-arm64".',
      }),
    }));

    const { SqliteKnowledgeStore: MockedStore } = await import('../../../src/store/sqlite-store.js');
    const store = new MockedStore(path.join(tempDir, 'k.sqlite'));

    let caught: unknown;
    try {
      store.open();
    } catch (error) {
      caught = error;
    }

    // NOTE: not `toBeInstanceOf(AppError)` — vi.resetModules() + dynamic
    // import() above gives sqlite-store.js (and everything it imports,
    // including utils/errors.js) a fresh module instance, so the AppError
    // class reference statically imported at the top of this file is not
    // the same class object. Duck-type on the fields instead.
    expect(caught).toMatchObject({
      name: 'AppError',
      code: 'NativeBindingError',
    });
    expect((caught as Error).message).toContain('npm rebuild better-sqlite3');
    expect((caught as Error).message).toMatch(/darwin-arm64/);
  });

  it('a subsequent call that needs the database re-throws the SAME recorded error, not a generic "not open" message', async () => {
    tempDir = await createTempDir('sqlite-requiredb-');

    vi.resetModules();
    vi.doMock('../../../src/store/native-binding-precheck.js', () => ({
      checkBetterSqlite3PrebuildAvailable: () => ({ ok: false, reason: 'simulated failure' }),
    }));

    const { SqliteKnowledgeStore: MockedStore } = await import('../../../src/store/sqlite-store.js');
    const store = new MockedStore(path.join(tempDir, 'k.sqlite'));

    expect(() => store.open()).toThrow(/npm rebuild better-sqlite3/);
    // getStats() -> requireDb() should surface the same NativeBindingError,
    // not "KnowledgeStore is not open. Call open() first."
    expect(() => store.getStats()).toThrow(/npm rebuild better-sqlite3/);
    try {
      store.getStats();
    } catch (error) {
      // See note above: not toBeInstanceOf(AppError) across a reset module graph.
      expect(error).toMatchObject({ name: 'AppError', code: 'NativeBindingError' });
    }
  });

  it('a store constructed with a pre-recorded openError (the degraded-startup path) reports it immediately, before open() is ever called', () => {
    const preRecorded = new AppError(
      'NativeBindingError',
      'better-sqlite3 failed to open at startup — run "npm rebuild better-sqlite3".',
    );
    const store = new SqliteKnowledgeStore('/tmp/does-not-matter.sqlite', preRecorded);

    expect(() => store.getStats()).toThrow(/npm rebuild better-sqlite3/);
  });

  it('control: a normal open() against a real, valid path still succeeds (the fixes above do not break the happy path)', async () => {
    tempDir = await createTempDir('sqlite-happy-path-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'k.sqlite'));
    expect(store.getStats().symbolCount).toBe(0);
    store.close();
  });
});

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { TYPES } from '../../../src/types/tokens.js';
import { AppError } from '../../../src/utils/errors.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

/**
 * The actual regression this guards against: before this fix,
 * createSqliteKnowledgeStore() throwing during createContainer() propagated
 * straight out of container construction — which, since this runs before
 * server.connect() in src/index.ts, meant the whole MCP server process
 * never started. No tool (including check_environment, built specifically
 * to diagnose this) ever became callable. A native-binding ABI mismatch —
 * the one failure mode this server is known to be able to hit — turned
 * into total, silent-ish startup failure instead of a diagnosable one.
 */
vi.mock('../../../src/store/sqlite-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/store/sqlite-store.js')>(
    '../../../src/store/sqlite-store.js',
  );
  return {
    ...actual,
    // Simulates open() throwing the same way it would for a real native
    // binding failure (ABI mismatch, missing prebuild, etc.) — the real
    // classification logic is already covered by
    // tests/unit/store/sqlite-store.test.ts; this test is specifically
    // about what createContainer() does when that happens.
    createSqliteKnowledgeStore: () => {
      throw new AppError(
        'NativeBindingError',
        "better-sqlite3's native database binding failed to load. Run \"npm rebuild better-sqlite3\".",
      );
    },
  };
});

describe('createContainer — startup resilience when the knowledge store fails to open', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('does not throw, and registers a KnowledgeStore that surfaces the same clear error on use', async () => {
    tempDir = await createTempDir('container-degraded-');
    const config: AppConfig = {
      repositoriesRoot: path.join(tempDir, 'repos'),
      indexPath: path.join(tempDir, 'k.sqlite'),
      indexOnUpdate: false,
    };

    const { createContainer } = await import('../../../src/server/container.js');

    let container: ReturnType<typeof createContainer> | undefined;
    expect(() => {
      container = createContainer({ config, logger: new SilentLogger() });
    }).not.toThrow();

    const store = container!.resolve<{ getStats: () => unknown }>(TYPES.KnowledgeStore);
    expect(() => store.getStats()).toThrow(/npm rebuild better-sqlite3/);
  });

  it('other tools that do not need the knowledge store still resolve and work (e.g. repository handlers)', async () => {
    tempDir = await createTempDir('container-degraded-other-');
    const config: AppConfig = {
      repositoriesRoot: path.join(tempDir, 'repos'),
      indexPath: path.join(tempDir, 'k.sqlite'),
      indexOnUpdate: false,
    };

    const { createContainer } = await import('../../../src/server/container.js');
    const container = createContainer({ config, logger: new SilentLogger() });

    expect(() => container.resolve(TYPES.RepositoryStatusHandler)).not.toThrow();
    expect(() => container.resolve(TYPES.CheckEnvironmentHandler)).not.toThrow();
  });
});

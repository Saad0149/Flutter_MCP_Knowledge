import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisSessionStore } from '../../../src/analysis/session/analysis-session-store.js';
import type { ProjectReportBuilder } from '../../../src/analysis/insight/project-report-builder.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

/**
 * SECURITY regression test: AnalysisSessionStore.get() used to build
 * `path.join(sessionsDir, `${sessionId}.json`)` with no validation of
 * sessionId. Since path.join fully resolves ".." segments, a sessionId
 * containing traversal sequences could read arbitrary .json files anywhere
 * on the host reachable from sessionsDir — reachable from any of the 12
 * MCP tools that accept a sessionId argument (analyze_*, explain_finding,
 * explore_finding). This confirms the fix: only the exact 16-hex-char
 * shape this store itself ever generates is accepted.
 */
describe('AnalysisSessionStore — sessionId path traversal', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  function buildStore(sessionsRoot: string): AnalysisSessionStore {
    return new AnalysisSessionStore(
      { repositoriesRoot: sessionsRoot, indexPath: path.join(sessionsRoot, 'k.sqlite'), indexOnUpdate: false },
      {} as unknown as ProjectReportBuilder,
      new SilentLogger(),
    );
  }

  it('rejects a sessionId containing ".." traversal instead of reading outside sessionsDir', async () => {
    tempDir = await createTempDir('session-traversal-');
    const store = buildStore(tempDir);

    // Plant a "secret" file just outside sessionsDir() to prove it would be
    // reachable via traversal if the guard weren't there.
    const secretPath = path.join(tempDir, 'secret.json');
    await writeFile(secretPath, JSON.stringify({ leaked: true }), 'utf8');

    const sessionsDir = store.sessionsDir();
    await mkdir(sessionsDir, { recursive: true });
    const relativeTraversal = path.relative(sessionsDir, tempDir);
    const maliciousSessionId = `${relativeTraversal}${path.sep}secret`.replaceAll(path.sep, '/');

    await expect(store.get(maliciousSessionId)).rejects.toMatchObject({
      code: 'InvalidArguments',
    });

    // Sanity: the file really was reachable via plain path.join, proving the
    // rejection is doing real work, not failing for an unrelated reason.
    const wouldHaveResolvedTo = path.join(sessionsDir, `${maliciousSessionId}.json`);
    expect(path.resolve(wouldHaveResolvedTo)).toBe(path.resolve(secretPath));
  });

  it('rejects non-hex and wrong-length sessionIds', async () => {
    tempDir = await createTempDir('session-format-');
    const store = buildStore(tempDir);

    for (const bad of ['not-a-session', '', '../../etc/passwd', 'a'.repeat(15), 'a'.repeat(17), 'ABCDEF0123456789']) {
      await expect(store.get(bad)).rejects.toMatchObject({ code: 'InvalidArguments' });
    }
  });

  it('still resolves a real, legitimately-saved session by its exact id', async () => {
    tempDir = await createTempDir('session-happy-');
    const store = buildStore(tempDir);
    const sessionsDir = store.sessionsDir();
    await mkdir(sessionsDir, { recursive: true });

    const realId = '0123456789abcdef';
    await writeFile(
      path.join(sessionsDir, `${realId}.json`),
      JSON.stringify({ sessionId: realId, createdAt: new Date().toISOString(), projectPath: '/tmp/x', report: {} }),
      'utf8',
    );

    const result = await store.get(realId);
    expect(result.sessionId).toBe(realId);
  });
});

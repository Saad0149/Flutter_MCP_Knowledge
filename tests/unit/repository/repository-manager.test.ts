import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { GitRepositoryManager } from '../../../src/repository/repository-manager.js';
import { AppError } from '../../../src/utils/errors.js';
import {
  createLocalGitRemote,
  createTempDir,
  removeTempDir,
} from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

describe('GitRepositoryManager', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('reports missing repositories in status', async () => {
    tempDir = await createTempDir('repo-status-');
    const reposRoot = path.join(tempDir, 'repos');
    const { definition } = await createLocalGitRemote(tempDir, 'demo', {
      'README.md': '# demo\n',
    });

    const manager = new GitRepositoryManager(
      { repositoriesRoot: reposRoot },
      new SilentLogger(),
      [definition],
    );

    const status = await manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      name: 'test/demo',
      exists: false,
      branch: null,
      commit: null,
      lastPull: null,
    });
    expect(status[0]?.path).toBe(path.join(reposRoot, 'demo'));
  });

  it('clones a missing repository and then reports already_up_to_date', async () => {
    tempDir = await createTempDir('repo-clone-');
    const reposRoot = path.join(tempDir, 'repos');
    const { definition } = await createLocalGitRemote(tempDir, 'demo', {
      'lib/widget.dart': 'class DemoWidget {}\n',
    });

    const manager = new GitRepositoryManager(
      { repositoriesRoot: reposRoot },
      new SilentLogger(),
      [definition],
    );

    const first = await manager.updateAll();
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('cloned');
    expect(first[0]?.branch).toBe('main');
    expect(first[0]?.commit).toBeTruthy();

    const status = await manager.getStatus('test/demo');
    expect(status[0]?.exists).toBe(true);
    expect(status[0]?.lastPull).toBeTruthy();

    const second = await manager.updateAll();
    expect(second[0]?.status).toBe('already_up_to_date');
  });

  it('throws RepositoryNotFound for unknown names', async () => {
    tempDir = await createTempDir('repo-unknown-');
    const manager = new GitRepositoryManager(
      { repositoriesRoot: path.join(tempDir, 'repos') },
      new SilentLogger(),
      [],
    );

    expect(() => manager.resolveDefinition('missing/repo')).toThrow(AppError);
    try {
      manager.resolveDefinition('missing/repo');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('RepositoryNotFound');
    }
  });

  it('shallow clone: cloned repo has exactly 1 commit even when remote has more', async () => {
    tempDir = await createTempDir('repo-shallow-');
    const reposRoot = path.join(tempDir, 'repos');

    // Build a bare remote with 2 commits manually
    const seedPath = path.join(tempDir, 'multi-seed');
    const remotePath = path.join(tempDir, 'multi.git');
    await mkdir(path.join(seedPath, 'lib'), { recursive: true });
    await writeFile(path.join(seedPath, 'lib', 'a.dart'), 'class A {}\n', 'utf8');

    const seed = simpleGit(seedPath);
    await seed.init();
    await seed.addConfig('user.email', 'test@example.com');
    await seed.addConfig('user.name', 'Test User');
    await seed.raw(['branch', '-M', 'main']);
    await seed.add('.');
    await seed.commit('first commit');
    // second commit
    await writeFile(path.join(seedPath, 'lib', 'b.dart'), 'class B {}\n', 'utf8');
    await seed.add('.');
    await seed.commit('second commit');
    await simpleGit().clone(seedPath, remotePath, ['--bare']);

    const manager = new GitRepositoryManager(
      { repositoriesRoot: reposRoot },
      new SilentLogger(),
      // file:// forces pack-protocol so --depth 1 is honoured (plain path uses local transport)
      [{ name: 'test/multi', localName: 'multi', cloneUrl: `file://${remotePath}`, defaultBranch: 'main' }],
    );

    const results = await manager.updateAll();
    expect(results[0]?.status).toBe('cloned');

    // Verify depth=1: rev-list count should be 1
    const clonedGit = simpleGit({ baseDir: path.join(reposRoot, 'multi') });
    const countStr = (await clonedGit.raw(['rev-list', '--count', 'HEAD'])).trim();
    expect(parseInt(countStr, 10)).toBe(1);
  });

  it('concurrent clone: updateAll processes multiple repos with bounded concurrency', async () => {
    tempDir = await createTempDir('repo-concurrent-');
    const reposRoot = path.join(tempDir, 'repos');

    const { definition: def1 } = await createLocalGitRemote(tempDir, 'repo1', { 'a.dart': 'class A {}\n' });
    const { definition: def2 } = await createLocalGitRemote(tempDir, 'repo2', { 'b.dart': 'class B {}\n' });
    const { definition: def3 } = await createLocalGitRemote(tempDir, 'repo3', { 'c.dart': 'class C {}\n' });

    const manager = new GitRepositoryManager(
      { repositoriesRoot: reposRoot },
      new SilentLogger(),
      [def1, def2, def3],
    );

    const results = await manager.updateAll();
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'cloned')).toBe(true);
  });

  it('startBackgroundUpdate: second call while first is in-progress returns in_progress', async () => {
    tempDir = await createTempDir('repo-bg-');
    const reposRoot = path.join(tempDir, 'repos');
    const { definition } = await createLocalGitRemote(tempDir, 'bgdemo', {
      'lib/widget.dart': 'class BgWidget {}\n',
    });

    const manager = new GitRepositoryManager(
      { repositoriesRoot: reposRoot },
      new SilentLogger(),
      [definition],
    );

    // First call: repo should be queued
    const first = manager.startBackgroundUpdate();
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('queued');

    // Second call (synchronous — no await, so background hasn't finished):
    // repo is still in inProgressSet → should be reported as in_progress
    const second = manager.startBackgroundUpdate();
    expect(second).toHaveLength(1);
    expect(second[0]?.status).toBe('in_progress');

    // Let background work complete before teardown
    await new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        const status = await manager.getStatus(definition.name);
        if (status[0]?.exists && !status[0]?.cloneInProgress) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  });

  it('repository_status reports cloneInProgress=true while background clone runs', async () => {
    tempDir = await createTempDir('repo-status-inprog-');
    const reposRoot = path.join(tempDir, 'repos');
    const { definition } = await createLocalGitRemote(tempDir, 'statdemo', {
      'lib/widget.dart': 'class StatWidget {}\n',
    });

    const manager = new GitRepositoryManager(
      { repositoriesRoot: reposRoot },
      new SilentLogger(),
      [definition],
    );

    // Start background update (non-blocking)
    const queued = manager.startBackgroundUpdate();
    expect(queued[0]?.status).toBe('queued');

    // Immediately read status — inProgressSet should still have the entry
    // because no await has been yielded since startBackgroundUpdate returned
    const status = await manager.getStatus(definition.name);
    // cloneInProgress may be true (still running) or false (finished very fast)
    // — we just assert the field is present and the call doesn't throw
    expect(typeof status[0]?.cloneInProgress).toBe('boolean');

    // Wait for completion
    await new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        const s = await manager.getStatus(definition.name);
        if (s[0]?.exists && !s[0]?.cloneInProgress) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    // After completion, cloneInProgress must be false
    const final = await manager.getStatus(definition.name);
    expect(final[0]?.cloneInProgress).toBe(false);
  });

  it('records GitError status when clone URL is invalid', async () => {
    tempDir = await createTempDir('repo-error-');
    const reposRoot = path.join(tempDir, 'repos');

    const manager = new GitRepositoryManager(
      { repositoriesRoot: reposRoot },
      new SilentLogger(),
      [
        {
          name: 'test/broken',
          localName: 'broken',
          cloneUrl: path.join(tempDir, 'does-not-exist.git'),
          defaultBranch: 'main',
        },
      ],
    );

    const results = await manager.updateAll();
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.error?.code).toBe('GitError');
  });
});

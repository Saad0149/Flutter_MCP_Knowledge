import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { RepositoryDefinition } from '../../src/repository/types.js';

export async function createTempDir(prefix = 'flutter-knowledge-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Creates a bare remote + a definition that clones from it.
 */
export async function createLocalGitRemote(
  root: string,
  name: string,
  files: Record<string, string>,
  branch = 'main',
): Promise<{ remotePath: string; definition: RepositoryDefinition }> {
  const remotePath = path.join(root, `${name}.git`);
  const seedPath = path.join(root, `${name}-seed`);

  await mkdir(seedPath, { recursive: true });

  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(seedPath, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  const seed = simpleGit(seedPath);
  await seed.init();
  await seed.addConfig('user.email', 'test@example.com');
  await seed.addConfig('user.name', 'Test User');
  // Normalize default branch name across Git versions.
  await seed.raw(['branch', '-M', branch]);
  await seed.add('.');
  await seed.commit('initial commit');

  // Create bare remote from seed
  await simpleGit().clone(seedPath, remotePath, ['--bare']);

  return {
    remotePath,
    definition: {
      name: `test/${name}`,
      localName: name,
      cloneUrl: remotePath,
      defaultBranch: branch,
    },
  };
}

export async function writeFixtureTree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

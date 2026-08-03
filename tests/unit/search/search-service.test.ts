import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemSearchEngine } from '../../../src/search/filesystem-search.js';
import { SearchService } from '../../../src/search/search-service.js';
import type { RepositoryDefinition, RepositoryManager, RepositoryStatus } from '../../../src/repository/types.js';
import { AppError } from '../../../src/utils/errors.js';
import { createTempDir, removeTempDir, writeFixtureTree } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

function createFakeRepositoryManager(
  root: string,
  definition: RepositoryDefinition,
): RepositoryManager {
  const status: RepositoryStatus = {
    name: definition.name,
    exists: true,
    path: path.join(root, definition.localName),
    branch: 'main',
    commit: 'abc123',
    lastPull: new Date().toISOString(),
  };

  return {
    ensureRoot: async () => undefined,
    updateAll: async () => [],
    updateOne: async () => ({
      name: definition.name,
      branch: 'main',
      commit: 'abc123',
      status: 'already_up_to_date',
      path: status.path,
    }),
    getStatus: async (name?: string) => {
      if (name && name !== definition.name && name !== definition.localName) {
        throw new AppError('RepositoryNotFound', `Unknown repository "${name}"`);
      }
      return [status];
    },
    getRepositoryPath: () => status.path,
    listDefinitions: () => [definition],
    resolveDefinition: (name: string) => {
      if (name !== definition.name && name !== definition.localName) {
        throw new AppError('RepositoryNotFound', `Unknown repository "${name}"`);
      }
      return definition;
    },
  };
}

describe('FilesystemSearchEngine / SearchService', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('finds filename and content matches with line numbers', async () => {
    tempDir = await createTempDir('search-');
    const definition = {
      name: 'flutter/flutter',
      localName: 'flutter',
      cloneUrl: 'unused',
      defaultBranch: 'master',
    };

    const repoPath = path.join(tempDir, 'flutter');
    await writeFixtureTree(repoPath, {
      'packages/flutter/lib/src/widgets/animated_container.dart': [
        '/// A container that animates.',
        'class AnimatedContainer extends StatefulWidget {',
        '  const AnimatedContainer({super.key});',
        '}',
        '',
      ].join('\n'),
      'packages/flutter/lib/src/widgets/container.dart': 'class Container {}\n',
      'README.md': 'Flutter framework\n',
    });

    const engine = new FilesystemSearchEngine(
      createFakeRepositoryManager(tempDir, definition),
      new SilentLogger(),
    );
    const service = new SearchService(engine, new SilentLogger());

    const byName = await service.search({
      query: 'animated_container',
      repository: 'flutter/flutter',
      searchContents: false,
    });

    expect(byName.matches.some((m) => m.matchType === 'filename')).toBe(true);

    const byContent = await service.search({
      query: 'class AnimatedContainer',
      repository: 'flutter/flutter',
      searchFilenames: false,
      include: ['**/*.dart'],
    });

    expect(byContent.matches.length).toBeGreaterThan(0);
    expect(byContent.matches[0]?.line).toBe(2);
    expect(byContent.matches[0]?.snippet).toContain('class AnimatedContainer');
  });

  it('rejects empty queries as InvalidArguments', async () => {
    tempDir = await createTempDir('search-empty-');
    const definition = {
      name: 'flutter/flutter',
      localName: 'flutter',
      cloneUrl: 'unused',
      defaultBranch: 'master',
    };

    await writeFixtureTree(path.join(tempDir, 'flutter'), {
      'a.dart': 'class A {}\n',
    });

    const service = new SearchService(
      new FilesystemSearchEngine(
        createFakeRepositoryManager(tempDir, definition),
        new SilentLogger(),
      ),
      new SilentLogger(),
    );

    await expect(service.search({ query: '   ' })).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === 'InvalidArguments',
    );
  });

  it('respects result limits and marks truncated', async () => {
    tempDir = await createTempDir('search-limit-');
    const definition = {
      name: 'flutter/packages',
      localName: 'packages',
      cloneUrl: 'unused',
      defaultBranch: 'main',
    };

    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) {
      files[`lib/file_${i}.dart`] = `const marker = ${i};\n`;
    }
    await writeFixtureTree(path.join(tempDir, 'packages'), files);

    const service = new SearchService(
      new FilesystemSearchEngine(
        createFakeRepositoryManager(tempDir, definition),
        new SilentLogger(),
      ),
      new SilentLogger(),
    );

    const response = await service.search({
      query: 'marker',
      repository: 'flutter/packages',
      limit: 3,
      searchFilenames: false,
    });

    expect(response.matches).toHaveLength(3);
    expect(response.truncated).toBe(true);
  });
});

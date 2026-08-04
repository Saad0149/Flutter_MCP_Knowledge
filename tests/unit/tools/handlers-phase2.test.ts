import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplainWidgetHandler } from '../../../src/tools/explain-widget.js';
import { FindBestPracticeHandler } from '../../../src/tools/find-best-practice.js';
import { FindExamplesHandler } from '../../../src/tools/find-examples.js';
import { FindTestsHandler } from '../../../src/tools/find-tests.js';
import { FindWidgetHandler } from '../../../src/tools/find-widget.js';
import { SearchDocsHandler } from '../../../src/tools/search-docs.js';
import { TraceWidgetHandler } from '../../../src/tools/trace-widget.js';
import { UpdateRepositoriesHandler } from '../../../src/tools/update-repositories.js';
import { ReindexHandler } from '../../../src/tools/reindex.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import type { SearchService } from '../../../src/search/search-service.js';
import type { RepositoryManager } from '../../../src/repository/types.js';
import { AppError } from '../../../src/utils/errors.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

describe('Phase 2/3 tool handlers', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  function seedStore(dbPath: string) {
    const store = createSqliteKnowledgeStore(dbPath);
    const repo = store.upsertRepository({
      name: 'flutter/flutter',
      path: '/repos/flutter',
      commitHash: 'abc',
    });
    store.markRepositoryIndexed(repo.id, 'abc');

    const file = store.upsertFile({
      repositoryId: repo.id,
      path: 'packages/flutter/lib/src/widgets/animated_container.dart',
      kind: 'dart',
      hash: 'h1',
      mtimeMs: 1,
    });
    store.replaceSymbolsForFile(file.id, [
      {
        fileId: file.id,
        name: 'AnimatedContainer',
        kind: 'class',
        line: 42,
        isWidget: true,
        isWidgetTest: false,
        docstring: 'A container that gradually changes its values over a period of time.',
        packageName: 'flutter',
        extendsClause: 'ImplicitlyAnimatedWidget',
        withClause: null,
        implementsClause: null,
      },
      {
        fileId: file.id,
        name: 'ImplicitlyAnimatedWidget',
        kind: 'class',
        line: 10,
        isWidget: true,
        isWidgetTest: false,
        docstring: 'Base class',
        packageName: 'flutter',
        extendsClause: 'StatefulWidget',
        withClause: null,
        implementsClause: null,
      },
    ]);

    const testFile = store.upsertFile({
      repositoryId: repo.id,
      path: 'packages/flutter/test/widgets/animated_container_test.dart',
      kind: 'dart',
      hash: 'h2',
      mtimeMs: 1,
    });
    store.replaceSymbolsForFile(testFile.id, [
      {
        fileId: testFile.id,
        name: 'animatedContainerTest',
        kind: 'function',
        line: 5,
        isWidget: false,
        isWidgetTest: true,
        docstring: null,
        packageName: 'flutter',
      },
    ]);

    const website = store.upsertRepository({
      name: 'flutter/website',
      path: '/repos/website',
      commitHash: 'def',
    });
    const docFile = store.upsertFile({
      repositoryId: website.id,
      path: 'src/content/cookbook/best-practices.md',
      kind: 'md',
      hash: 'h3',
      mtimeMs: 1,
    });
    store.replaceDocsForFile(docFile.id, [
      {
        fileId: docFile.id,
        title: 'Best practices for keys',
        chunk: 'Prefer using keys when reordering lists of widgets.',
        lineStart: 1,
        docKind: 'cookbook',
      },
    ]);

    const samples = store.upsertRepository({
      name: 'flutter/samples',
      path: '/repos/samples',
      commitHash: 'ghi',
    });
    const sampleFile = store.upsertFile({
      repositoryId: samples.id,
      path: 'animations/example/lib/main.dart',
      kind: 'dart',
      hash: 'h4',
      mtimeMs: 1,
    });
    store.replaceSymbolsForFile(sampleFile.id, [
      {
        fileId: sampleFile.id,
        name: 'AnimatedSample',
        kind: 'class',
        line: 3,
        isWidget: true,
        isWidgetTest: false,
        docstring: 'Sample animation',
        packageName: null,
        extendsClause: 'StatelessWidget',
      },
    ]);

    return store;
  }

  it('find_widget prefers index hits', async () => {
    tempDir = await createTempDir('fw-');
    const store = seedStore(path.join(tempDir, 'k.sqlite'));
    const searchService = { search: vi.fn() } as unknown as SearchService;
    const handler = new FindWidgetHandler(searchService, store);
    const result = await handler.execute({ name: 'AnimatedContainer' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('index');
      expect(result.data.package).toBe('flutter');
      expect(result.data.file).toContain('animated_container.dart');
    }
    expect(searchService.search).not.toHaveBeenCalled();
    store.close();
  });

  it('update_repositories returns queued status immediately (non-blocking)', () => {
    const repositories = {
      startBackgroundUpdate: vi.fn().mockReturnValue([
        { name: 'flutter/flutter', status: 'queued', path: '/repos/flutter' },
        { name: 'flutter/packages', status: 'in_progress', path: '/repos/packages' },
      ]),
    } as unknown as RepositoryManager;

    const handler = new UpdateRepositoriesHandler(repositories, new SilentLogger());

    const result = handler.execute();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repositories).toHaveLength(2);
      expect(result.data.repositories[0]?.status).toBe('queued');
      expect(result.data.repositories[1]?.status).toBe('in_progress');
      expect(result.data.note).toMatch(/repository_status/);
    }
  });

  it('reindex validates arguments', async () => {
    const handler = new ReindexHandler({
      indexAll: vi.fn(),
      indexRepository: vi.fn(),
    } as unknown as Indexer);
    const result = await handler.execute({ repository: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('InvalidArguments');
    }
  });

  it('explain_widget / search_docs / find_tests / trace / examples / best_practice', async () => {
    tempDir = await createTempDir('tools-');
    const store = seedStore(path.join(tempDir, 'k.sqlite'));

    const explain = await new ExplainWidgetHandler(store).execute({ name: 'AnimatedContainer' });
    expect(explain.success).toBe(true);
    if (explain.success) {
      expect(explain.data.found).toBe(true);
    }

    const docs = await new SearchDocsHandler(store).execute({ query: 'keys' });
    expect(docs.success).toBe(true);
    if (docs.success) {
      expect(docs.data.totalMatches).toBeGreaterThan(0);
    }

    const tests = await new FindTestsHandler(store).execute({ symbol: 'animatedContainer' });
    expect(tests.success).toBe(true);
    if (tests.success) {
      expect(tests.data.totalMatches).toBeGreaterThan(0);
    }

    const trace = await new TraceWidgetHandler(store).execute({ symbol: 'AnimatedContainer' });
    expect(trace.success).toBe(true);
    if (trace.success) {
      expect(trace.data.found).toBe(true);
      expect(trace.data.tree?.extendsClause).toContain('ImplicitlyAnimatedWidget');
    }

    const examples = await new FindExamplesHandler(store).execute({ topic: 'Animated' });
    expect(examples.success).toBe(true);
    if (examples.success) {
      expect(examples.data.totalMatches).toBeGreaterThan(0);
    }

    const practices = await new FindBestPracticeHandler(store).execute({ topic: 'keys' });
    expect(practices.success).toBe(true);
    if (practices.success) {
      expect(['website', 'cookbook']).toContain(practices.data.results[0]?.source);
    }

    store.close();
  });

  it('update_repositories returns structured errors when startBackgroundUpdate throws', () => {
    const handler = new UpdateRepositoriesHandler(
      {
        startBackgroundUpdate: vi.fn().mockImplementation(() => {
          throw new AppError('GitError', 'dispatch failed');
        }),
      } as unknown as RepositoryManager,
      new SilentLogger(),
    );
    const result = handler.execute();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('GitError');
    }
  });
});

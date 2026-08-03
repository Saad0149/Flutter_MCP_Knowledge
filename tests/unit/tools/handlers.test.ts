import { describe, expect, it, vi } from 'vitest';
import type { RepositoryManager } from '../../../src/repository/types.js';
import type { SearchService } from '../../../src/search/search-service.js';
import { FindWidgetHandler } from '../../../src/tools/find-widget.js';
import { RepositoryStatusHandler } from '../../../src/tools/repository-status.js';
import { SearchSourceHandler } from '../../../src/tools/search-source.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import path from 'node:path';
import { afterEach } from 'vitest';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';

describe('MCP tool handlers (Phase 1 compatibility)', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('repository_status validates arguments', async () => {
    const repositories = {
      getStatus: vi.fn(),
    } as unknown as RepositoryManager;

    const handler = new RepositoryStatusHandler(repositories);
    const result = await handler.execute({ repository: '' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('InvalidArguments');
    }
    expect(repositories.getStatus).not.toHaveBeenCalled();
  });

  it('search_source maps engine matches into tool results', async () => {
    const searchService = {
      search: vi.fn().mockResolvedValue({
        query: 'AnimatedContainer',
        totalMatches: 1,
        truncated: false,
        matches: [
          {
            repository: 'flutter/flutter',
            file: 'lib/a.dart',
            absolutePath: '/repos/flutter/lib/a.dart',
            line: 10,
            snippet: 'class AnimatedContainer',
            matchType: 'content',
          },
        ],
      }),
    } as unknown as SearchService;

    const handler = new SearchSourceHandler(searchService);
    const result = await handler.execute({ query: 'AnimatedContainer' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0]).toEqual({
        repository: 'flutter/flutter',
        file: 'lib/a.dart',
        line: 10,
        snippet: 'class AnimatedContainer',
        matchType: 'content',
      });
    }
  });

  it('find_widget falls back to filesystem when index is empty', async () => {
    tempDir = await createTempDir('fw-empty-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'empty.sqlite'));

    const searchService = {
      search: vi.fn().mockResolvedValue({
        query: 'class AnimatedContainer',
        totalMatches: 1,
        truncated: false,
        matches: [
          {
            repository: 'flutter/flutter',
            file: 'packages/flutter/lib/src/widgets/animated_container.dart',
            absolutePath:
              '/repos/flutter/packages/flutter/lib/src/widgets/animated_container.dart',
            line: 42,
            snippet: 'class AnimatedContainer extends StatefulWidget {',
            matchType: 'content',
          },
        ],
      }),
    } as unknown as SearchService;

    const handler = new FindWidgetHandler(searchService, store);
    const result = await handler.execute({ name: 'AnimatedContainer' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('filesystem');
      expect(result.data.widget).toBe('AnimatedContainer');
      expect(result.data.package).toBe('flutter');
    }

    store.close();
  });
});

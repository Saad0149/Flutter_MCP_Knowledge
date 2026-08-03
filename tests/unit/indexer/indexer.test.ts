import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeuristicSymbolExtractor } from '../../../src/parser/heuristic-extractor.js';
import { RepositoryIndexer } from '../../../src/indexer/repository-indexer.js';
import type { RepositoryDefinition, RepositoryManager } from '../../../src/repository/types.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';

describe('HeuristicSymbolExtractor', () => {
  const extractor = new HeuristicSymbolExtractor();

  it('extracts classes, mixins, enums and widget hints', () => {
    const source = `
/// A fancy box.
class FancyBox extends StatelessWidget {
  const FancyBox({super.key});
}

mixin BoxMixin on Widget {}

enum BoxSize { small, large }

extension BoxX on FancyBox {}
`;
    const result = extractor.extractDart(source, 'packages/flutter/lib/src/widgets/fancy_box.dart');
    const names = result.symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['FancyBox', 'BoxMixin', 'BoxSize', 'BoxX']));

    const fancy = result.symbols.find((s) => s.name === 'FancyBox');
    expect(fancy?.isWidget).toBe(true);
    expect(fancy?.docstring).toContain('A fancy box');
    expect(fancy?.packageName).toBe('flutter');
    expect(fancy?.extendsClause).toContain('StatelessWidget');
  });

  it('chunks markdown by headings', () => {
    const md = `# Title

Intro paragraph.

## Section

Details here.
`;
    const result = extractor.extractMarkdown(md, 'docs/guide.md');
    expect(result.docs.length).toBeGreaterThanOrEqual(2);
    expect(result.docs[0]?.title).toBe('Title');
  });
});

describe('SqliteKnowledgeStore + Indexer', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('indexes dart and markdown files incrementally', async () => {
    tempDir = await createTempDir('index-');
    const repoPath = path.join(tempDir, 'flutter');
    await mkdir(path.join(repoPath, 'lib'), { recursive: true });
    await writeFile(
      path.join(repoPath, 'lib', 'widget.dart'),
      '/// Docs\nclass DemoWidget extends StatelessWidget {}\n',
      'utf8',
    );
    await writeFile(path.join(repoPath, 'README.md'), '# Demo\n\nHello world.\n', 'utf8');

    const store = createSqliteKnowledgeStore(path.join(tempDir, 'knowledge.sqlite'));
    const definition: RepositoryDefinition = {
      name: 'flutter/flutter',
      localName: 'flutter',
      cloneUrl: 'https://example.com/flutter.git',
      defaultBranch: 'master',
    };

    const repositories = {
      listDefinitions: () => [definition],
      resolveDefinition: () => definition,
      getRepositoryPath: () => repoPath,
      ensureRoot: async () => undefined,
      updateAll: async () => [],
      updateOne: async () => ({
        name: definition.name,
        branch: 'master',
        commit: 'abc',
        status: 'already_up_to_date' as const,
        path: repoPath,
      }),
      getStatus: async () => [
        {
          name: definition.name,
          exists: true,
          path: repoPath,
          branch: 'master',
          commit: 'abc123',
          lastPull: null,
        },
      ],
    } as unknown as RepositoryManager;

    const analyzer = {
      analyzeFiles: async () => ({ available: false, files: [], warning: 'test' }),
      toInsertSymbols: () => [],
      isAvailable: async () => false,
      getHelperPath: () => '',
    } as unknown as DartAnalyzerClient;

    const indexer = new RepositoryIndexer(
      new SilentLogger(),
      repositories,
      store,
      new HeuristicSymbolExtractor(),
      analyzer,
    );

    const first = await indexer.indexRepository('flutter/flutter');
    expect(first.status).toBe('indexed');
    expect(first.filesUpdated).toBe(2);
    expect(store.getStats().symbolCount).toBeGreaterThan(0);
    expect(store.getStats().docCount).toBeGreaterThan(0);

    const widget = store.getSymbolByName('DemoWidget', { isWidget: true });
    expect(widget?.filePath).toContain('widget.dart');

    const second = await indexer.indexRepository('flutter/flutter');
    expect(second.filesUpdated).toBe(0);

    store.close();
  });
});

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FindIntendedBehaviorHandler } from '../../../src/tools/find-intended-behavior.js';
import { SearchDocsHandler } from '../../../src/tools/search-docs.js';
import { IntendedBehaviourEngine } from '../../../src/analysis/insight/intended-behaviour-engine.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';

describe('Phase 4 tools', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('search_docs filters by docKind and find_intended_behavior joins sources', async () => {
    tempDir = await createTempDir('p4-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'k.sqlite'));

    const flutter = store.upsertRepository({
      name: 'flutter/flutter',
      path: '/repos/flutter',
      commitHash: 'a',
    });
    const website = store.upsertRepository({
      name: 'flutter/website',
      path: '/repos/website',
      commitHash: 'b',
    });

    const src = store.upsertFile({
      repositoryId: flutter.id,
      path: 'packages/flutter/lib/src/widgets/container.dart',
      kind: 'dart',
      hash: '1',
      mtimeMs: 1,
    });
    store.replaceSymbolsForFile(src.id, [
      {
        fileId: src.id,
        name: 'Container',
        kind: 'class',
        line: 10,
        isWidget: true,
        isWidgetTest: false,
        docstring: 'A convenience widget.',
        packageName: 'flutter',
        extendsClause: 'StatelessWidget',
      },
    ]);

    const testFile = store.upsertFile({
      repositoryId: flutter.id,
      path: 'packages/flutter/test/widgets/container_test.dart',
      kind: 'dart',
      hash: '2',
      mtimeMs: 1,
    });
    store.replaceSymbolsForFile(testFile.id, [
      {
        fileId: testFile.id,
        name: 'containerDefaults',
        kind: 'function',
        line: 20,
        isWidget: false,
        isWidgetTest: true,
        docstring: 'Tests Container defaults',
        packageName: 'flutter',
      },
    ]);

    const mig = store.upsertFile({
      repositoryId: website.id,
      path: 'src/content/release/breaking-changes/container.md',
      kind: 'md',
      hash: '3',
      mtimeMs: 1,
    });
    store.replaceDocsForFile(mig.id, [
      {
        fileId: mig.id,
        title: 'Container migration',
        chunk: 'How to migrate Container usage.',
        lineStart: 1,
        docKind: 'migration',
      },
    ]);

    const changelog = store.upsertFile({
      repositoryId: flutter.id,
      path: 'CHANGELOG.md',
      kind: 'md',
      hash: '4',
      mtimeMs: 1,
    });
    store.replaceDocsForFile(changelog.id, [
      {
        fileId: changelog.id,
        title: '3.16.0',
        chunk: 'Container improvements and fixes.',
        lineStart: 1,
        docKind: 'changelog',
      },
    ]);

    const docs = await new SearchDocsHandler(store).execute({
      query: 'Container',
      docKind: 'migration',
    });
    expect(docs.success).toBe(true);
    if (docs.success) {
      expect(docs.data.results).toHaveLength(1);
      expect(docs.data.results[0]?.docKind).toBe('migration');
    }

    const intended = await new FindIntendedBehaviorHandler(
      new IntendedBehaviourEngine(store),
    ).execute({
      topic: 'Container',
    });
    expect(intended.success).toBe(true);
    if (intended.success) {
      expect(intended.data.exhaustedAllSources).toBe(true);
      expect(intended.data.status === 'ok' || intended.data.status === 'empty').toBe(true);
      const kinds = intended.data.results.map((r) => r.kind);
      expect(kinds).toContain('widget_test');
      expect(kinds).toContain('migration');
      expect(kinds).toContain('source');
      expect(kinds).toContain('changelog');
    }

    store.close();
  });
});

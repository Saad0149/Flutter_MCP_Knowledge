import { inject, injectable } from 'tsyringe';
import type { KnowledgeStore } from '../../store/types.js';
import { TYPES } from '../../types/tokens.js';

export type BehaviourSourceStep =
  | 'official_docs'
  | 'framework_source'
  | 'framework_tests'
  | 'official_samples'
  | 'migration_guides'
  | 'changelog'
  | 'package_docs'
  | 'community';

export interface IntendedBehaviourHit {
  readonly kind: BehaviourSourceStep;
  readonly repository: string;
  readonly file: string;
  readonly line: number | null;
  readonly title: string | null;
  readonly snippet: string;
  readonly confidence: number;
  readonly authority: 'official' | 'community';
}

export interface IntendedBehaviourResult {
  readonly topic: string;
  readonly results: readonly IntendedBehaviourHit[];
  readonly searchedSteps: readonly BehaviourSourceStep[];
  readonly exhaustedAllSources: boolean;
  readonly summary: string;
  readonly status: 'ok' | 'empty' | 'blocked';
  readonly knowledgeBase?: {
    readonly available: boolean;
    readonly reason: string;
    readonly expectedSources: readonly string[];
    readonly nextStep: string;
    readonly indexedRepositoryCount: number;
    readonly indexedSymbolCount: number;
  };
}

/**
 * Cascading intended-behaviour search across the local knowledge index.
 * Never returns empty until every step has been attempted.
 */
@injectable()
export class IntendedBehaviourEngine {
  constructor(@inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore) {}

  search(topic: string, limit = 25): IntendedBehaviourResult {
    const indexedRepos = this.store.listRepositories().length;
    const probe = this.store.findSymbols({ limit: 1 });
    const indexedSymbols = probe.length; // presence check; full count not required

    const expectedSources = [
      'flutter/flutter',
      'flutter/samples',
      'flutter/packages',
      'flutter/website',
      'dart-lang/sdk',
      'dart-lang/site-www',
    ] as const;

    if (indexedRepos === 0 || indexedSymbols === 0) {
      // Still run cascade so searchedSteps is honest, but surface blocked status.
      const emptySearch = this.runCascade(topic, limit);
      return {
        topic,
        results: emptySearch.results,
        searchedSteps: emptySearch.searchedSteps,
        exhaustedAllSources: true,
        status: 'blocked',
        summary:
          'Knowledge base unavailable — Flutter/Dart repositories are not indexed. Project analyzers still work; intended-behaviour lookup cannot until you clone and index official sources.',
        knowledgeBase: {
          available: false,
          reason: 'Flutter repositories not indexed (index empty or missing official repos).',
          expectedSources: [...expectedSources],
          nextStep: 'Run update_repositories, then reindex on this MCP server.',
          indexedRepositoryCount: indexedRepos,
          indexedSymbolCount: indexedSymbols,
        },
      };
    }

    const result = this.runCascade(topic, limit);
    if (result.results.length === 0) {
      return {
        topic,
        ...result,
        status: 'empty',
        summary: `Searched all ${result.searchedSteps.length} knowledge sources for "${topic}" with no indexed matches. Try a more specific Flutter API/widget name, or expand the index.`,
        knowledgeBase: {
          available: true,
          reason: 'Index is present but no matches for this topic.',
          expectedSources: [...expectedSources],
          nextStep: 'Try a concrete widget/API name (e.g. StatefulWidget, Provider).',
          indexedRepositoryCount: indexedRepos,
          indexedSymbolCount: -1,
        },
      };
    }

    return {
      topic,
      ...result,
      status: 'ok',
      summary: `Found ${result.results.length} intended-behaviour match(es) for "${topic}" after cascading ${result.searchedSteps.length} knowledge sources.`,
      knowledgeBase: {
        available: true,
        reason: 'Official knowledge index available.',
        expectedSources: [...expectedSources],
        nextStep: 'Use matched samples/docs as reference implementations.',
        indexedRepositoryCount: indexedRepos,
        indexedSymbolCount: -1,
      },
    };
  }

  private runCascade(
    topic: string,
    limit: number,
  ): Pick<IntendedBehaviourResult, 'results' | 'searchedSteps' | 'exhaustedAllSources'> {
    const results: IntendedBehaviourHit[] = [];
    const searchedSteps: BehaviourSourceStep[] = [];

    // Step 1 — Official Flutter / Dart docs
    searchedSteps.push('official_docs');
    for (const repo of ['flutter/website', 'dart-lang/site-www'] as const) {
      for (const doc of this.store.findDocs({
        query: topic,
        repositoryName: repo,
        docKinds: ['guide', 'cookbook', 'general'],
        limit: 8,
      })) {
        results.push({
          kind: 'official_docs',
          repository: doc.repositoryName,
          file: doc.filePath,
          line: doc.lineStart,
          title: doc.title,
          snippet: doc.chunk.slice(0, 240),
          confidence: 0.95,
          authority: 'official',
        });
      }
    }

    // Step 2 — Framework source
    searchedSteps.push('framework_source');
    const sourceHits = [
      this.store.getSymbolByName(topic, { isWidget: true, repositoryName: 'flutter/flutter' }),
      this.store.getSymbolByName(topic, { repositoryName: 'flutter/flutter' }),
      this.store.getSymbolByName(topic, { repositoryName: 'dart-lang/sdk' }),
      this.store.getSymbolByName(topic, { repositoryName: 'flutter/packages' }),
      ...this.store.findSymbols({ nameContains: topic, limit: 8 }),
    ].filter(Boolean);
    for (const hit of sourceHits) {
      if (!hit || hit.isWidgetTest) continue;
      results.push({
        kind: 'framework_source',
        repository: hit.repositoryName,
        file: hit.filePath,
        line: hit.line,
        title: hit.name,
        snippet:
          hit.docstring?.split('\n')[0] ??
          `${hit.kind} ${hit.name}${hit.extendsClause ? ` extends ${hit.extendsClause}` : ''}`,
        confidence: hit.repositoryName === 'flutter/flutter' ? 0.98 : 0.9,
        authority: 'official',
      });
    }

    // Step 3 — Framework / widget tests
    searchedSteps.push('framework_tests');
    for (const hit of this.store.findSymbols({
      nameContains: topic,
      isWidgetTest: true,
      limit: 10,
    })) {
      results.push({
        kind: 'framework_tests',
        repository: hit.repositoryName,
        file: hit.filePath,
        line: hit.line,
        title: hit.name,
        snippet: hit.docstring?.split('\n')[0] ?? `${hit.kind} ${hit.name}`,
        confidence: 0.92,
        authority: 'official',
      });
    }

    // Step 4 — Official samples
    searchedSteps.push('official_samples');
    for (const hit of this.store.findSymbols({
      nameContains: topic,
      underExample: true,
      limit: 10,
    })) {
      results.push({
        kind: 'official_samples',
        repository: hit.repositoryName,
        file: hit.filePath,
        line: hit.line,
        title: hit.name,
        snippet: hit.docstring?.split('\n')[0] ?? `${hit.kind} ${hit.name}`,
        confidence: 0.9,
        authority: 'official',
      });
    }

    // Step 5 — Migration guides + CHANGELOG
    searchedSteps.push('migration_guides');
    for (const doc of this.store.findDocs({
      query: topic,
      docKinds: ['migration', 'changelog'],
      limit: 10,
    })) {
      results.push({
        kind: doc.docKind === 'changelog' ? 'changelog' : 'migration_guides',
        repository: doc.repositoryName,
        file: doc.filePath,
        line: doc.lineStart,
        title: doc.title,
        snippet: doc.chunk.slice(0, 240),
        confidence: doc.docKind === 'changelog' ? 0.86 : 0.88,
        authority: 'official',
      });
    }

    // Step 6 — Package documentation (packages repo + remaining docs)
    searchedSteps.push('package_docs');
    for (const doc of this.store.findDocs({
      query: topic,
      repositoryName: 'flutter/packages',
      limit: 6,
    })) {
      results.push({
        kind: 'package_docs',
        repository: doc.repositoryName,
        file: doc.filePath,
        line: doc.lineStart,
        title: doc.title,
        snippet: doc.chunk.slice(0, 240),
        confidence: 0.85,
        authority: 'official',
      });
    }

    // Step 7 — Community (only if indexed)
    searchedSteps.push('community');
    for (const repo of ['community/stackoverflow', 'community/github-issues'] as const) {
      for (const doc of this.store.findDocs({ query: topic, repositoryName: repo, limit: 5 })) {
        results.push({
          kind: 'community',
          repository: doc.repositoryName,
          file: doc.filePath,
          line: doc.lineStart,
          title: doc.title,
          snippet: doc.chunk.slice(0, 240),
          confidence: 0.55,
          authority: 'community',
        });
      }
    }

    const deduped = dedupeHits(results)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);

    return {
      results: deduped,
      searchedSteps,
      exhaustedAllSources: true,
    };
  }
}

function dedupeHits(hits: IntendedBehaviourHit[]): IntendedBehaviourHit[] {
  const seen = new Set<string>();
  const out: IntendedBehaviourHit[] = [];
  for (const hit of hits) {
    const key = `${hit.kind}|${hit.repository}|${hit.file}|${hit.line}|${hit.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

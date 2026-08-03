import { inject, injectable } from 'tsyringe';
import type { KnowledgeStore } from '../../store/types.js';
import { TYPES } from '../../types/tokens.js';
import type { AnalysisFinding, OfficialReference } from '../types.js';

const OFFICIAL_REPOS = [
  'flutter/website',
  'dart-lang/site-www',
  'flutter/flutter',
  'flutter/samples',
  'flutter/packages',
  'dart-lang/sdk',
] as const;

const CODE_QUERIES: Readonly<Record<string, readonly string[]>> = {
  PresentationImportsData: [
    'architecture',
    'clean architecture',
    'repository pattern',
    'separation of concerns',
  ],
  DomainImportsFlutter: ['architecture', 'domain layer', 'pure dart'],
  DomainImportsData: ['dependency inversion', 'repository', 'architecture'],
  CircularDependencies: ['circular dependency', 'import', 'library'],
  GodClassCandidate: ['effective dart', 'design', 'single responsibility'],
  LargeBuildMethod: ['extract widget', 'performance', 'build method'],
  LegacyButtonApi: ['ElevatedButton', 'TextButton', 'OutlinedButton', 'buttons'],
  DebugPrint: ['debugPrint', 'logging'],
  ConstOpportunities: ['const constructors', 'performance'],
  MissingDispose: ['TextEditingController', 'dispose', 'StatefulWidget'],
  HeavySetState: ['state management', 'StatefulWidget', 'setState'],
  LogicInWidgets: ['architecture', 'state management'],
  NoTests: ['testing', 'widget test', 'flutter test'],
  HasAnalysisOptions: ['analysis options', 'linter'],
  NoAnalysisOptions: ['analysis options', 'flutter_lints'],
  DetectedArchitecture: ['app architecture', 'architecture'],
  DetectedApproaches: ['state management'],
  PatternMatching: ['patterns', 'switch'],
  ModernClassModifiers: ['class modifiers', 'sealed'],
  UsesMixins: ['mixins'],
  UsesExtensions: ['extension methods'],
};

/**
 * Resolves official (and, when indexed, community) references for findings.
 * Official sources always win. Never invents Flutter rules.
 */
@injectable()
export class KnowledgeEngine {
  constructor(@inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore) {}

  enrichFinding(finding: AnalysisFinding): AnalysisFinding {
    const resolved = this.resolveForFinding(finding);
    if (resolved.length === 0) {
      return finding;
    }
    const merged = mergeRefs(finding.officialReferences ?? [], finding.officialReference, resolved);
    return {
      ...finding,
      officialReference: merged[0],
      officialReferences: merged,
    };
  }

  enrichAll(findings: readonly AnalysisFinding[]): AnalysisFinding[] {
    return findings.map((f) => this.enrichFinding(f));
  }

  resolveForFinding(finding: AnalysisFinding): OfficialReference[] {
    const queries = [
      ...(CODE_QUERIES[finding.code] ?? []),
      ...finding.title.split(/\s+/).filter((w) => w.length > 4).slice(0, 3),
      finding.code.replace(/([a-z])([A-Z])/g, '$1 $2'),
    ];

    const results: OfficialReference[] = [];

    // 1) Official docs
    for (const query of queries) {
      for (const repo of ['flutter/website', 'dart-lang/site-www'] as const) {
        for (const doc of this.store.findDocs({ query, repositoryName: repo, limit: 2 })) {
          results.push({
            repository: doc.repositoryName,
            file: doc.filePath,
            line: doc.lineStart,
            authority: 'official',
            kind: mapDocKind(doc.docKind),
            title: doc.title,
            snippet: doc.chunk.slice(0, 180),
          });
        }
      }
    }

    // 2) Framework symbols / API
    for (const query of queries) {
      const symbolName = query.replace(/\s+/g, '');
      for (const repo of OFFICIAL_REPOS) {
        const hit =
          this.store.getSymbolByName(symbolName, { repositoryName: repo }) ??
          this.store.getSymbolByName(symbolName, { isWidget: true, repositoryName: repo });
        if (hit) {
          results.push({
            repository: hit.repositoryName,
            file: hit.filePath,
            line: hit.line,
            authority: 'official',
            kind: hit.isWidgetTest ? 'widget_test' : 'framework_source',
            title: hit.name,
            snippet: hit.docstring?.split('\n')[0] ?? null,
          });
        }
      }
    }

    // 3) Samples
    for (const query of queries.slice(0, 2)) {
      for (const hit of this.store.findSymbols({
        nameContains: query.split(/\s+/)[0] ?? query,
        underExample: true,
        limit: 2,
      })) {
        results.push({
          repository: hit.repositoryName,
          file: hit.filePath,
          line: hit.line,
          authority: 'official',
          kind: 'sample',
          title: hit.name,
          snippet: hit.docstring?.split('\n')[0] ?? null,
        });
      }
    }

    // 4) Widget tests
    for (const query of queries.slice(0, 2)) {
      for (const hit of this.store.findSymbols({
        nameContains: query.split(/\s+/)[0] ?? query,
        isWidgetTest: true,
        limit: 2,
      })) {
        results.push({
          repository: hit.repositoryName,
          file: hit.filePath,
          line: hit.line,
          authority: 'official',
          kind: 'widget_test',
          title: hit.name,
          snippet: hit.docstring?.split('\n')[0] ?? null,
        });
      }
    }

    // 5) Migrations / changelogs
    for (const query of queries.slice(0, 2)) {
      for (const doc of this.store.findDocs({
        query,
        docKinds: ['migration', 'changelog', 'cookbook'],
        limit: 3,
      })) {
        results.push({
          repository: doc.repositoryName,
          file: doc.filePath,
          line: doc.lineStart,
          authority: 'official',
          kind: mapDocKind(doc.docKind),
          title: doc.title,
          snippet: doc.chunk.slice(0, 180),
        });
      }
    }

    // Community (GitHub issues / SO) — only if indexed under those names later
    for (const query of queries.slice(0, 1)) {
      for (const doc of this.store.findDocs({
        query,
        repositoryName: 'community/stackoverflow',
        limit: 1,
      })) {
        results.push({
          repository: doc.repositoryName,
          file: doc.filePath,
          line: doc.lineStart,
          authority: 'community',
          kind: 'community',
          title: doc.title,
          snippet: doc.chunk.slice(0, 180),
        });
      }
    }

    return prioritize(results).slice(0, 8);
  }
}

function mapDocKind(
  kind: string,
): NonNullable<OfficialReference['kind']> {
  if (kind === 'migration') return 'migration';
  if (kind === 'changelog') return 'changelog';
  if (kind === 'cookbook' || kind === 'guide') return 'documentation';
  return 'documentation';
}

function mergeRefs(
  existing: readonly OfficialReference[],
  primary: OfficialReference | undefined,
  resolved: readonly OfficialReference[],
): OfficialReference[] {
  const all = [...(primary ? [primary] : []), ...existing, ...resolved];
  return prioritize(all);
}

function prioritize(refs: readonly OfficialReference[]): OfficialReference[] {
  const rank = (r: OfficialReference): number => {
    const auth = r.authority === 'community' ? 2 : r.authority === 'generated' ? 3 : 0;
    const kindRank =
      r.kind === 'documentation'
        ? 0
        : r.kind === 'framework_source'
          ? 1
          : r.kind === 'sample'
            ? 2
            : r.kind === 'widget_test'
              ? 3
              : r.kind === 'migration'
                ? 4
                : 5;
    return auth * 10 + kindRank;
  };

  const seen = new Set<string>();
  return [...refs]
    .sort((a, b) => rank(a) - rank(b))
    .filter((r) => {
      const key = `${r.repository}|${r.file}|${r.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

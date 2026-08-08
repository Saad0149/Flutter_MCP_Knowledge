import { describe, expect, it } from 'vitest';
import { DependencyAnalyzer } from '../../../src/analysis/engines/dependency-analyzer.js';
import { OfficialReferenceResolver } from '../../../src/analysis/official-refs.js';
import type { ProjectSnapshot } from '../../../src/analysis/types.js';
import type { KnowledgeStore } from '../../../src/store/types.js';

const stubStore = {
  getSymbolByName: () => null,
  findDocs: () => [],
} as unknown as KnowledgeStore;

function baseSnapshot(importEdges: readonly { from: string; to: string }[]): ProjectSnapshot {
  return {
    projectPath: '/fixture',
    hasPubspec: true,
    pubspecRaw: 'name: fixture\n',
    packageName: 'fixture',
    dependencies: [],
    devDependencies: [],
    isFlutterProject: true,
    hasAnalysisOptions: true,
    libExists: true,
    testExists: false,
    topLevelDirs: ['lib'],
    libDirs: ['lib'],
    dartFiles: [],
    symbols: [],
    importEdges,
    astMeta: { source: 'dart_analyzer', coverage: 'full', filesAnalyzed: 0, filesTotal: 0, baseConfidence: 1 },
  };
}

/**
 * SECURITY / robustness regression: detectCycles() used to be a plain
 * recursive `dfs()` — one JS call-stack frame per edge traversed. A long
 * linear import chain (entirely plausible in a large real monorepo, not
 * just an adversarial construction) could exceed Node's stack size and
 * throw RangeError. It's now an explicit-stack iterative DFS with no such
 * limit.
 */
describe('DependencyAnalyzer.detectCycles (via analyze())', () => {
  it('does not stack-overflow on a very long linear import chain', () => {
    const CHAIN_LENGTH = 50_000;
    const edges = Array.from({ length: CHAIN_LENGTH - 1 }, (_, i) => ({
      from: `lib/file_${i}.dart`,
      to: `lib/file_${i + 1}.dart`,
    }));
    const analyzer = new DependencyAnalyzer(new OfficialReferenceResolver(stubStore));

    expect(() => analyzer.analyze(baseSnapshot(edges))).not.toThrow();
    const result = analyzer.analyze(baseSnapshot(edges));
    // A linear chain has no cycle.
    expect(result.facts.circularCycles).toEqual([]);
  });

  it('still correctly detects a real cycle after the iterative rewrite', () => {
    const edges = [
      { from: 'lib/a.dart', to: 'lib/b.dart' },
      { from: 'lib/b.dart', to: 'lib/c.dart' },
      { from: 'lib/c.dart', to: 'lib/a.dart' },
    ];
    const analyzer = new DependencyAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(baseSnapshot(edges));

    expect(result.facts.circularCycles.length).toBe(1);
    expect(result.facts.circularCycles[0]).toContain('lib/a.dart');
    expect(result.facts.circularCycles[0]).toContain('lib/b.dart');
    expect(result.facts.circularCycles[0]).toContain('lib/c.dart');
    expect(result.findings.some((f) => f.code === 'CircularDependencies')).toBe(true);
  });

  it('caps cycle detection at 25 rather than growing without bound', () => {
    // 30 independent 2-node cycles: a0<->b0, a1<->b1, ...
    const edges: { from: string; to: string }[] = [];
    for (let i = 0; i < 30; i += 1) {
      edges.push({ from: `lib/a${i}.dart`, to: `lib/b${i}.dart` });
      edges.push({ from: `lib/b${i}.dart`, to: `lib/a${i}.dart` });
    }
    const analyzer = new DependencyAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(baseSnapshot(edges));

    expect(result.facts.circularCycles.length).toBeLessThanOrEqual(25);
  });
});

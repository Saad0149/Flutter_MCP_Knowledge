import { describe, expect, it } from 'vitest';
import { PerformanceAnalyzer } from '../../../src/analysis/engines/performance-analyzer.js';
import { OfficialReferenceResolver } from '../../../src/analysis/official-refs.js';
import type { AstMeta, DartFileInfo, ProjectSnapshot } from '../../../src/analysis/types.js';
import type { KnowledgeStore } from '../../../src/store/types.js';

/**
 * Regression coverage for CONFIDENCE_AUDIT.md's LargeBuildMethod/
 * CompactBuildMethods and ListViewBuilderMisuse findings — both now read
 * real AST-derived facts (`DartFileInfo.astMetrics`, populated from
 * parser/bin/extract_symbols.dart's extended visitor) instead of manual
 * brace-matching / single-shape regex over raw text. This exercises
 * PerformanceAnalyzer directly (bypassing the real Dart subprocess — see
 * extract-symbols-metrics.test.ts for the Dart-side visitor itself),
 * hand-injecting astMetrics the way AstAdapter would, and comparing against
 * the same content with astMetrics absent (the heuristic-fallback path,
 * which deliberately still uses the old logic).
 */
describe('PerformanceAnalyzer LargeBuildMethod/ListViewBuilderMisuse — real AST metrics vs. the old bugs', () => {
  const stubStore = {
    getSymbolByName: () => null,
    findDocs: () => [],
  } as unknown as KnowledgeStore;

  function astMeta(source: AstMeta['source']): AstMeta {
    return {
      source,
      coverage: 'full',
      filesAnalyzed: 1,
      filesTotal: 1,
      baseConfidence: source === 'dart_analyzer' ? 1 : 0.75,
    };
  }

  function buildSnapshot(file: DartFileInfo, source: AstMeta['source']): ProjectSnapshot {
    return {
      projectPath: '/fixture',
      hasPubspec: true,
      pubspecRaw: 'name: fixture\ndependencies:\n  flutter:\n    sdk: flutter\n',
      packageName: 'fixture',
      dependencies: ['flutter'],
      devDependencies: [],
      isFlutterProject: true,
      hasAnalysisOptions: true,
      libExists: true,
      testExists: false,
      topLevelDirs: ['lib'],
      libDirs: ['lib'],
      dartFiles: [file],
      symbols: [],
      importEdges: [],
      astMeta: astMeta(source),
    };
  }

  // A genuinely large (>60-line) build() body, but with a stray unmatched
  // `}` inside a string literal on an early line — old brace-matching
  // (`extractBuildMethodLines`) counts characters textually regardless of
  // string context, so this stray `}` makes its running depth counter hit
  // zero after just 2 lines and stop there, undercounting the method's
  // real length. Real AST body spans (from FunctionBody offsets) aren't
  // affected by string content at all.
  function buildBigBodyWithStrayBrace(): string {
    const filler = Array.from({ length: 65 }, (_, i) => `    print('line ${i}');`).join('\n');
    return `class MyWidget extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final s = 'unexpected } brace inside a string, unbalanced';
${filler}
    return Text(s);
  }
}
`;
  }

  it('LargeBuildMethod: with real astMetrics, a stray unbalanced brace inside a string does not truncate the measured span', () => {
    const content = buildBigBodyWithStrayBrace();
    const file: DartFileInfo = {
      relativePath: 'lib/big_build.dart',
      absolutePath: '/fixture/lib/big_build.dart',
      lineCount: content.split('\n').length,
      content,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: {
        branchCount: 0,
        maxNestingDepth: 0,
        // Real AST body span: from the opening `{` of build()'s body to its
        // closing `}` — 68 lines (line 3 through line 70 inclusive of this
        // fixture), correctly unaffected by the stray `}` inside the string.
        buildMethods: [{ line: 3, startLine: 3, endLine: 70, approxLines: 68 }],
        listViewEagerCalls: [],
      },
    };
    const snapshot = buildSnapshot(file, 'dart_analyzer');
    const result = new PerformanceAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    expect(result.facts.largeBuildMethodCount).toBe(1);
    expect(result.facts.largeBuildMethods[0]?.approxLines).toBe(68);
    const finding = result.findings.find((f) => f.code === 'LargeBuildMethod');
    expect(finding).toBeDefined();
    expect(finding!.basis).toBe('ast');
  });

  it('LargeBuildMethod: the SAME content without astMetrics (heuristic fallback) reproduces the old truncation bug and misses it', () => {
    const content = buildBigBodyWithStrayBrace();
    const file: DartFileInfo = {
      relativePath: 'lib/big_build.dart',
      absolutePath: '/fixture/lib/big_build.dart',
      lineCount: content.split('\n').length,
      content,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: null,
    };
    const snapshot = buildSnapshot(file, 'heuristic');
    const result = new PerformanceAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    // The stray `}` inside the string terminates the old brace-matching
    // scan after 2 lines, well under the 60-line threshold — a false
    // negative, and the exact bug CONFIDENCE_AUDIT.md flagged for
    // LargeBuildMethod. CompactBuildMethods fires instead ("no large build
    // methods detected"), which is now actively wrong for this file.
    expect(result.facts.largeBuildMethodCount).toBe(0);
    expect(result.findings.find((f) => f.code === 'LargeBuildMethod')).toBeUndefined();
    const compact = result.findings.find((f) => f.code === 'CompactBuildMethods');
    expect(compact).toBeDefined();
    expect(compact!.basis).toBe('heuristic_fallback');
  });

  // `children:` isn't the first named argument — the old regex
  // (/ListView\(children:\s*\[/) only matches when `children:` immediately
  // follows the opening paren, so a `padding:` argument listed first makes
  // it miss the eager children array entirely (verified empirically: this
  // exact call does not match that regex).
  const listViewWithPrecedingArg =
    "    return ListView(padding: const EdgeInsets.all(8), children: [Text('a')]);";

  it('ListViewBuilderMisuse: with real astMetrics, a children: argument that is not first is still detected', () => {
    const content = `class MyWidget extends StatelessWidget {
  Widget build(BuildContext context) {
${listViewWithPrecedingArg}
  }
}
`;
    const file: DartFileInfo = {
      relativePath: 'lib/listview_arg_order.dart',
      absolutePath: '/fixture/lib/listview_arg_order.dart',
      lineCount: content.split('\n').length,
      content,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: {
        branchCount: 0,
        maxNestingDepth: 0,
        buildMethods: [{ line: 2, startLine: 2, endLine: 4, approxLines: 3 }],
        listViewEagerCalls: [{ line: 3 }],
      },
    };
    const snapshot = buildSnapshot(file, 'dart_analyzer');
    const result = new PerformanceAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    expect(result.facts.listViewBuilderMisuse).toBe(1);
    const finding = result.findings.find((f) => f.code === 'ListViewBuilderMisuse');
    expect(finding).toBeDefined();
    expect(finding!.basis).toBe('ast');
  });

  it('ListViewBuilderMisuse: the SAME content without astMetrics (heuristic fallback) reproduces the old argument-order miss', () => {
    const content = `class MyWidget extends StatelessWidget {
  Widget build(BuildContext context) {
${listViewWithPrecedingArg}
  }
}
`;
    const file: DartFileInfo = {
      relativePath: 'lib/listview_arg_order.dart',
      absolutePath: '/fixture/lib/listview_arg_order.dart',
      lineCount: content.split('\n').length,
      content,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: null,
    };
    const snapshot = buildSnapshot(file, 'heuristic');
    const result = new PerformanceAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    expect(result.facts.listViewBuilderMisuse).toBe(0);
    expect(result.findings.find((f) => f.code === 'ListViewBuilderMisuse')).toBeUndefined();
  });
});

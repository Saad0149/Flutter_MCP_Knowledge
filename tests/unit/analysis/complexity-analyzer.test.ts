import { describe, expect, it } from 'vitest';
import { ComplexityAnalyzer } from '../../../src/analysis/engines/complexity-analyzer.js';
import { OfficialReferenceResolver } from '../../../src/analysis/official-refs.js';
import type { AstMeta, DartFileInfo, ProjectSnapshot } from '../../../src/analysis/types.js';
import type { KnowledgeStore } from '../../../src/store/types.js';

/**
 * Regression coverage for CONFIDENCE_AUDIT.md's HighComplexityFiles and
 * DeepNesting findings: the old heuristics (`estimateCyclomaticComplexity`'s
 * whole-file regex, `estimateNestingDepth`'s whole-file brace counting) are
 * demonstrably wrong on content with zero real branching/control-flow
 * nesting. This exercises ComplexityAnalyzer directly (bypassing the real
 * Dart analyzer subprocess — see extract-symbols-metrics.test.ts for
 * coverage of the Dart-side visitor itself) by hand-injecting
 * `DartFileInfo.astMetrics` exactly as AstAdapter would populate it from a
 * real scan, and comparing against the same content with astMetrics absent
 * (the heuristic-fallback path, which deliberately still uses the old
 * regex).
 */
describe('ComplexityAnalyzer HighComplexityFiles/DeepNesting — real AST metrics vs. the old regex bugs', () => {
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

  // A help-text string literal that happens to contain control-flow
  // keywords as plain English words ("if", "switch", "catch", "for", "do",
  // "while", "else") — zero real control flow, one field declaration. The
  // old regex (/\b(if|else|for|while|do|switch|case|catch|&&|\|\||\?)\b/g)
  // matches keyword text anywhere in the file, string/comment content
  // included (verified: this exact string produces 12 matches under that
  // regex), which is the "includes matches inside strings/comments" bug
  // CONFIDENCE_AUDIT.md flagged for HighComplexityFiles.
  const stringContentWithKeywords =
    "  String help = 'if you need help, use the switch to toggle, or catch an " +
    "error and retry. for now, do nothing while we wait, else just log it. " +
    "try again if it fails again for good measure while testing switch cases " +
    "and catch blocks.';";

  it('HighComplexityFiles: with real astMetrics, keyword text inside a string literal is NOT counted (branchCount=0)', () => {
    const file: DartFileInfo = {
      relativePath: 'lib/help_text.dart',
      absolutePath: '/fixture/lib/help_text.dart',
      lineCount: 3,
      content: `class Docs {\n${stringContentWithKeywords}\n}\n`,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: {
        branchCount: 0,
        maxNestingDepth: 0,
        buildMethods: [],
        listViewEagerCalls: [],
      },
    };
    const snapshot = buildSnapshot(file, 'dart_analyzer');
    const result = new ComplexityAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    expect(result.facts.estimatedHighComplexityFiles).toBe(0);
    expect(result.findings.find((f) => f.code === 'HighComplexityFiles')).toBeUndefined();
  });

  it('HighComplexityFiles: the SAME content without astMetrics (heuristic fallback) reproduces the old string-content overcount bug', () => {
    const file: DartFileInfo = {
      relativePath: 'lib/help_text.dart',
      absolutePath: '/fixture/lib/help_text.dart',
      lineCount: 3,
      content: `class Docs {\n${stringContentWithKeywords}\n}\n`,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: null,
    };
    const snapshot = buildSnapshot(file, 'heuristic');
    const result = new ComplexityAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    // 12 keyword-shaped words inside the string literal >= the 10-hit
    // file-level threshold — the exact old bug CONFIDENCE_AUDIT.md flagged.
    // This is the documented fallback behavior for heuristic-mode scans,
    // not itself a bug.
    expect(result.facts.estimatedHighComplexityFiles).toBe(1);
    const finding = result.findings.find((f) => f.code === 'HighComplexityFiles');
    expect(finding).toBeDefined();
    expect(finding!.basis).toBe('heuristic_fallback');
  });

  // 7 levels of nested map literal, zero control flow. The old
  // estimateNestingDepth counts raw `{`/`}` depth across the whole file, so
  // it can't tell a nested map literal from nested if/for/while (verified:
  // this exact content produces brace-depth 7, clearing the >6 threshold,
  // under that old function).
  const nestedLiteralContent = `const config = {
  'a': {
    'b': {
      'c': {
        'd': {
          'e': {
            'f': {
              'g': 1,
            },
          },
        },
      },
    },
  },
};
`;

  it('DeepNesting: with real astMetrics, a deeply nested map literal is NOT counted (maxNestingDepth=0, no control flow)', () => {
    const file: DartFileInfo = {
      relativePath: 'lib/nested_literal.dart',
      absolutePath: '/fixture/lib/nested_literal.dart',
      lineCount: nestedLiteralContent.split('\n').length,
      content: nestedLiteralContent,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: {
        branchCount: 0,
        maxNestingDepth: 0,
        buildMethods: [],
        listViewEagerCalls: [],
      },
    };
    const snapshot = buildSnapshot(file, 'dart_analyzer');
    const result = new ComplexityAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    expect(result.facts.deepNestingFileCount).toBe(0);
    expect(result.findings.find((f) => f.code === 'DeepNesting')).toBeUndefined();
  });

  it('DeepNesting: the SAME content without astMetrics (heuristic fallback) reproduces the old brace-conflation bug', () => {
    const file: DartFileInfo = {
      relativePath: 'lib/nested_literal.dart',
      absolutePath: '/fixture/lib/nested_literal.dart',
      lineCount: nestedLiteralContent.split('\n').length,
      content: nestedLiteralContent,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: null,
    };
    const snapshot = buildSnapshot(file, 'heuristic');
    const result = new ComplexityAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    // Whole-file brace depth is 7 (>6 threshold) even though there's zero
    // real control-flow nesting — the exact old bug CONFIDENCE_AUDIT.md
    // flagged. Documented fallback behavior for heuristic-mode scans.
    expect(result.facts.deepNestingFileCount).toBe(1);
    const finding = result.findings.find((f) => f.code === 'DeepNesting');
    expect(finding).toBeDefined();
    expect(finding!.basis).toBe('heuristic_fallback');
  });

  it('DeepNesting finding uses astOrFallback(ast) basis and the upgraded confidence value when AST-backed', () => {
    // A file whose control flow really is nested >= 6 deep, with real
    // astMetrics reporting that honestly.
    const content = 'class C {\n  void run() {}\n}\n';
    const file: DartFileInfo = {
      relativePath: 'lib/deep.dart',
      absolutePath: '/fixture/lib/deep.dart',
      lineCount: 3,
      content,
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: {
        branchCount: 6,
        maxNestingDepth: 6,
        buildMethods: [],
        listViewEagerCalls: [],
      },
    };
    const snapshot = buildSnapshot(file, 'dart_analyzer');
    const result = new ComplexityAnalyzer(new OfficialReferenceResolver(stubStore)).analyze(snapshot);

    const finding = result.findings.find((f) => f.code === 'DeepNesting');
    expect(finding).toBeDefined();
    expect(finding!.basis).toBe('ast');
    expect(finding!.confidence).toBeGreaterThan(0.6); // strictly above the old pattern-basis value
  });
});

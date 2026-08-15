import { describe, expect, it } from 'vitest';
import { CodeQualityAnalyzer } from '../../../src/analysis/engines/code-quality-analyzer.js';
import { OfficialReferenceResolver } from '../../../src/analysis/official-refs.js';
import type { DartFileInfo, ProjectSnapshot, SymbolInfo } from '../../../src/analysis/types.js';
import type { KnowledgeStore } from '../../../src/store/types.js';

/**
 * Regression coverage for a real bug: on 2026-08-05/06 the Code Quality
 * analyzer reported drastically different god-class/large-class counts
 * (85/241 vs 131/339) across two review runs of the *same unchanged*
 * project. Investigation traced it to a Dart-detection reliability fix
 * (dart-sdk-locator.ts, landed in a "diagnostics tool" commit that never
 * touched this file) which changed whether AstAdapter used the real Dart
 * analyzer or the heuristic regex extractor — NOT a change in this
 * analyzer's own threshold/scoring logic. See git history: this file has
 * never been modified since the initial commit.
 *
 * This test builds a ProjectSnapshot BY HAND (bypassing AstAdapter/the
 * heuristic extractor/the real Dart analyzer entirely) so it exercises only
 * CodeQualityAnalyzer's own god-class scoring and >=400 LOC threshold
 * counting, with hand-verified expected counts. It is immune to which
 * symbol-extraction backend is available in whatever environment runs the
 * suite, and will fail loudly if the threshold, scoring weights, or dedup
 * logic in code-quality-analyzer.ts ever drift on unchanged input.
 */
describe('CodeQualityAnalyzer god-class / large-class regression fixture', () => {
  function dartFile(overrides: Partial<DartFileInfo> & { relativePath: string }): DartFileInfo {
    return {
      absolutePath: `/fixture/${overrides.relativePath}`,
      lineCount: 1,
      content: '',
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: null,
      ...overrides,
    };
  }

  function padLines(lines: string[], targetLineCount: number): string[] {
    while (lines.length < targetLineCount) {
      lines.push('// padding');
    }
    return lines;
  }

  // --- File 1: hand-tuned to score exactly 75 (>= 70 god-class threshold) ---
  // score = +25 (loc>=400) +20 (methodCount>=20) +15 (fieldCount>=15) +15 (importCount>=20) = 75
  const godClassMethodLines = Array.from({ length: 20 }, (_, i) => `  void method${i}() {}`);
  const godClassFieldLines = Array.from({ length: 15 }, (_, i) => `  final int field${i} = ${i};`);
  const godClassLines = padLines(
    ['class BigGodService {', ...godClassMethodLines, ...godClassFieldLines, '}'],
    400,
  );
  const godClassImports = Array.from({ length: 20 }, (_, i) => `package:fixture/dep_${i}.dart`);

  // --- File 2: >=400 LOC (large-class candidate) but NO other signals ---
  // score = +25 (loc>=400) only = 25, well under the 70 god-class threshold.
  const largeOnlyLines = padLines(['class LargePlainWidget {', '}'], 410);

  // --- File 3: small file, should not appear in either list at all ---
  const smallLines = ['class TinyHelper {', '  void run() {}', '}'];

  const dartFiles: DartFileInfo[] = [
    dartFile({
      relativePath: 'lib/services/big_god_service.dart',
      lineCount: godClassLines.length,
      content: godClassLines.join('\n'),
      imports: godClassImports,
    }),
    dartFile({
      relativePath: 'lib/widgets/large_plain_widget.dart',
      lineCount: largeOnlyLines.length,
      content: largeOnlyLines.join('\n'),
      imports: ['package:fixture/only_one.dart'],
    }),
    dartFile({
      relativePath: 'lib/utils/tiny_helper.dart',
      lineCount: smallLines.length,
      content: smallLines.join('\n'),
      imports: [],
    }),
  ];

  const symbols: SymbolInfo[] = [
    {
      name: 'BigGodService',
      kind: 'class',
      line: 1,
      isWidget: false,
      docstring: null,
      extendsClause: null,
      withClause: null,
      implementsClause: null,
      filePath: 'lib/services/big_god_service.dart',
    },
    {
      name: 'LargePlainWidget',
      kind: 'class',
      line: 1,
      isWidget: true,
      docstring: null,
      extendsClause: 'StatelessWidget',
      withClause: null,
      implementsClause: null,
      filePath: 'lib/widgets/large_plain_widget.dart',
    },
    {
      name: 'TinyHelper',
      kind: 'class',
      line: 1,
      isWidget: false,
      docstring: null,
      extendsClause: null,
      withClause: null,
      implementsClause: null,
      filePath: 'lib/utils/tiny_helper.dart',
    },
  ];

  const snapshot: ProjectSnapshot = {
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
    dartFiles,
    symbols,
    importEdges: [],
    astMeta: {
      source: 'dart_analyzer',
      coverage: 'full',
      filesAnalyzed: dartFiles.length,
      filesTotal: dartFiles.length,
      baseConfidence: 1,
    },
  };

  const stubStore = {
    getSymbolByName: () => null,
    findDocs: () => [],
  } as unknown as KnowledgeStore;

  it('counts exactly the hand-verified large-class and god-class candidates', () => {
    const analyzer = new CodeQualityAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(snapshot);

    // Sanity: input symbol population is exactly what we built (catches this
    // test itself drifting, not just the analyzer).
    expect(result.facts.classCount).toBe(3);

    // Both BigGodService (400 LOC) and LargePlainWidget (410 LOC) clear the
    // >=400 LOC size-only threshold; TinyHelper (3 LOC) does not.
    expect(result.facts.largeClassCandidates).toHaveLength(2);
    expect(result.facts.largeClassCandidates.some((c) => c.startsWith('BigGodService'))).toBe(
      true,
    );
    expect(
      result.facts.largeClassCandidates.some((c) => c.startsWith('LargePlainWidget')),
    ).toBe(true);

    // Only BigGodService clears the multi-signal score>=70 god-class bar
    // (loc 25 + methodCount 20 + fieldCount 15 + importCount 15 = 75).
    // LargePlainWidget scores only 25 (loc alone) and must NOT appear.
    expect(result.facts.godClassDetails).toHaveLength(1);
    expect(result.facts.godClassDetails[0]?.name).toBe('BigGodService');
    expect(result.facts.godClassDetails[0]?.score).toBe(75);
    expect(result.facts.godClassDetails[0]?.methodCount).toBeGreaterThanOrEqual(20);
    expect(result.facts.godClassDetails[0]?.fieldCount).toBeGreaterThanOrEqual(15);
    expect(result.facts.godClassDetails[0]?.importCount).toBe(20);

    // The GodClassCandidate finding fires with exactly this population.
    const godClassFinding = result.findings.find((f) => f.code === 'GodClassCandidate');
    expect(godClassFinding).toBeDefined();
  });

  it('is deterministic across repeated calls on the identical snapshot', () => {
    const analyzer = new CodeQualityAnalyzer(new OfficialReferenceResolver(stubStore));
    const first = analyzer.analyze(snapshot);
    const second = analyzer.analyze(snapshot);

    expect(second.facts.largeClassCandidates.length).toBe(first.facts.largeClassCandidates.length);
    expect(second.facts.godClassDetails.length).toBe(first.facts.godClassDetails.length);
  });

  it('GodClassCandidate basis is always "pattern" — scoreGodClass() is regex over content regardless of AST availability', () => {
    // Regression for CONFIDENCE_AUDIT.md's mislabel finding: class
    // *discovery* uses the real symbol table (astMeta.source ===
    // 'dart_analyzer' in this fixture), but the god-class *score* itself
    // (methodCount/fieldCount/importCount/responsibilityHints) is always
    // regex over raw file content. Previously this finding used
    // astOrFallback(ast), which incorrectly reported basis: 'ast' here.
    const analyzer = new CodeQualityAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(snapshot);
    const godClassFinding = result.findings.find((f) => f.code === 'GodClassCandidate');
    expect(godClassFinding).toBeDefined();
    expect(godClassFinding!.basis).toBe('pattern');
  });
});

/**
 * Regression coverage for CONFIDENCE_AUDIT.md's DeepInheritance finding:
 * `inheritanceDepthHint()` used to count whitespace-split tokens in a
 * class's own `extends` clause string — not a measure of inheritance depth
 * at all. It now recursively walks each class's real `extendsClause`
 * through the project's own symbol table, stopping at the project boundary
 * (Flutter/Dart SDK classes, or anything else not defined in this project).
 */
describe('CodeQualityAnalyzer DeepInheritance — real chain walk vs. the old token-count bug', () => {
  function dartFile(relativePath: string): DartFileInfo {
    return {
      relativePath,
      absolutePath: `/fixture/${relativePath}`,
      lineCount: 1,
      content: '',
      imports: [],
      packageImports: [],
      relativeImports: [],
      astMetrics: null,
    };
  }

  function classSymbol(
    name: string,
    extendsClause: string | null,
    filePath: string,
  ): SymbolInfo {
    return {
      name,
      kind: 'class',
      line: 1,
      isWidget: false,
      docstring: null,
      extendsClause,
      withClause: null,
      implementsClause: null,
      filePath,
    };
  }

  const symbols: SymbolInfo[] = [
    // Old bug — FALSE POSITIVE: a single real extends hop to a generic
    // base whose type-argument list happens to contain commas/spaces.
    // Old hint: 'GenericBase<A, B, C>'.split(/\s+/) -> 3 tokens -> "depth 3"
    // (wrongly >= the threshold). Real depth: Widget extends one thing
    // (GenericBase, not itself project-local) -> depth 1, correctly NOT deep.
    classSymbol('CommaGenericWidget', 'GenericBase<A, B, C>', 'lib/comma_generic.dart'),

    // Old bug — FALSE NEGATIVE: a genuine 3-hop project-local chain where
    // every individual extends clause is a single token (no whitespace),
    // so the old hint always returned 1 for each class and never flagged
    // it. Real chain: GrandChild -> Child -> Parent -> StatefulWidget (SDK
    // boundary), a true depth of 3.
    classSymbol('GrandChild', 'Child', 'lib/grandchild.dart'),
    classSymbol('Child', 'Parent', 'lib/child.dart'),
    classSymbol('Parent', 'StatefulWidget', 'lib/parent.dart'),

    // Shallow, project-local, single hop — must NOT be flagged.
    classSymbol('ShallowWidget', 'BaseWidget', 'lib/shallow.dart'),
    classSymbol('BaseWidget', null, 'lib/base_widget.dart'),
  ];

  const dartFiles: DartFileInfo[] = [
    dartFile('lib/comma_generic.dart'),
    dartFile('lib/grandchild.dart'),
    dartFile('lib/child.dart'),
    dartFile('lib/parent.dart'),
    dartFile('lib/shallow.dart'),
    dartFile('lib/base_widget.dart'),
  ];

  const snapshot: ProjectSnapshot = {
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
    dartFiles,
    symbols,
    importEdges: [],
    astMeta: {
      source: 'dart_analyzer',
      coverage: 'full',
      filesAnalyzed: dartFiles.length,
      filesTotal: dartFiles.length,
      baseConfidence: 1,
    },
  };

  const stubStore = {
    getSymbolByName: () => null,
    findDocs: () => [],
  } as unknown as KnowledgeStore;

  it('does not flag a single real extends hop just because its generic type args contain commas/spaces', () => {
    const analyzer = new CodeQualityAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(snapshot);
    expect(result.facts.deepInheritance.some((d) => d.startsWith('CommaGenericWidget'))).toBe(
      false,
    );
  });

  it('flags a genuine 3-hop project-local chain even though every individual extends clause is a single token', () => {
    const analyzer = new CodeQualityAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(snapshot);
    expect(result.facts.deepInheritance.some((d) => d.startsWith('GrandChild'))).toBe(true);
    expect(
      result.facts.deepInheritance.find((d) => d.startsWith('GrandChild')),
    ).toContain('depth 3');
  });

  it('does not flag intermediate classes in the chain that individually fall below the threshold', () => {
    const analyzer = new CodeQualityAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(snapshot);
    // Child (depth 2) and Parent (depth 1) must not appear themselves,
    // even though they're ancestors of the flagged GrandChild.
    expect(result.facts.deepInheritance.some((d) => d.startsWith('Child extends'))).toBe(false);
    expect(result.facts.deepInheritance.some((d) => d.startsWith('Parent extends'))).toBe(false);
  });

  it('does not flag a shallow, single-hop, project-local extends', () => {
    const analyzer = new CodeQualityAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(snapshot);
    expect(result.facts.deepInheritance.some((d) => d.startsWith('ShallowWidget'))).toBe(false);
  });

  it('DeepInheritance basis follows astOrFallback(ast) — ast here since this fixture has a real symbol table', () => {
    const analyzer = new CodeQualityAnalyzer(new OfficialReferenceResolver(stubStore));
    const result = analyzer.analyze(snapshot);
    const deepInheritanceFinding = result.findings.find((f) => f.code === 'DeepInheritance');
    expect(deepInheritanceFinding).toBeDefined();
    expect(deepInheritanceFinding!.basis).toBe('ast');
  });
});

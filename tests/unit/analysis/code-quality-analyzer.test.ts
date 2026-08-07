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
});

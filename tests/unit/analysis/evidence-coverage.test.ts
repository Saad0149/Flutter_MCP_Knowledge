import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AstAdapter } from '../../../src/analysis/ast/ast-adapter.js';
import { TechnicalDebtEngine } from '../../../src/analysis/debt/technical-debt-engine.js';
import { AccessibilityAnalyzer } from '../../../src/analysis/engines/accessibility-analyzer.js';
import { ArchitectureAnalyzer } from '../../../src/analysis/engines/architecture-analyzer.js';
import { ArchitectureMatchEngine } from '../../../src/analysis/engines/architecture-match-engine.js';
import { CodeQualityAnalyzer } from '../../../src/analysis/engines/code-quality-analyzer.js';
import { ComplexityAnalyzer } from '../../../src/analysis/engines/complexity-analyzer.js';
import { DependencyAnalyzer } from '../../../src/analysis/engines/dependency-analyzer.js';
import { DocumentationAnalyzer } from '../../../src/analysis/engines/documentation-analyzer.js';
import { PerformanceAnalyzer } from '../../../src/analysis/engines/performance-analyzer.js';
import { StateManagementAnalyzer } from '../../../src/analysis/engines/state-management-analyzer.js';
import { TestingAnalyzer } from '../../../src/analysis/engines/testing-analyzer.js';
import { EvidenceEngine } from '../../../src/analysis/evidence/evidence-engine.js';
import { ExplanationEngine } from '../../../src/analysis/insight/explanation-engine.js';
import { PriorityActionEngine } from '../../../src/analysis/insight/priority-action-engine.js';
import { ProjectHealthScorer } from '../../../src/analysis/insight/project-health-scorer.js';
import { deriveFindingPriority } from '../../../src/analysis/insight/finding-priority.js';
import { ProjectReportBuilder } from '../../../src/analysis/insight/project-report-builder.js';
import { RecommendationEngine } from '../../../src/analysis/insight/recommendation-engine.js';
import { KnowledgeEngine } from '../../../src/analysis/knowledge/knowledge-engine.js';
import { MetricsEngine } from '../../../src/analysis/metrics/metrics-engine.js';
import { OfficialReferenceResolver } from '../../../src/analysis/official-refs.js';
import { ProjectScanner } from '../../../src/analysis/project-scanner.js';
import { FindingRelationshipEngine } from '../../../src/analysis/relationships/finding-relationship-engine.js';
import { RuleEngine } from '../../../src/analysis/rules/rule-engine.js';
import { ScoringEngine } from '../../../src/analysis/scoring/scoring-engine.js';
import type { AnalysisFinding } from '../../../src/analysis/types.js';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { HeuristicSymbolExtractor } from '../../../src/parser/heuristic-extractor.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import { AnalysisSessionStore } from '../../../src/analysis/session/analysis-session-store.js';
import { ExplainFindingHandler } from '../../../src/tools/explain-finding.js';
import { ReviewProjectHandler } from '../../../src/tools/review-project.js';
import { sampleFilesFor } from '../../../src/tools/tool-response-helpers.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

function unavailableDartClient(): DartAnalyzerClient {
  return {
    isAvailable: async () => false,
    analyzeFiles: async () => ({ available: false, files: [], warning: 'unavailable' }),
    getHelperPath: () => '',
    toInsertSymbols: () => [],
  } as unknown as DartAnalyzerClient;
}

function baseFinding(
  overrides: Partial<AnalysisFinding> &
    Pick<AnalysisFinding, 'code' | 'category' | 'severity' | 'scoreImpact' | 'confidence'>,
): AnalysisFinding {
  return {
    title: overrides.code,
    description: overrides.code,
    evidence: [],
    recommendedFix: null,
    source: 'heuristic',
    basis: 'pattern',
    ...overrides,
  };
}

describe('deriveFindingPriority — critical requires locatable evidence (unit-level)', () => {
  it('downgrades an otherwise-critical finding to high when it has no locatable file evidence', () => {
    const f = baseFinding({
      code: 'SyntheticAggregate',
      category: 'other',
      severity: 'negative',
      scoreImpact: -20,
      confidence: 0.95,
      evidence: ['count=999'],
    });
    expect(deriveFindingPriority(f)).toBe('high');
  });

  it('keeps critical when the same impact/confidence finding has locatable evidence', () => {
    const f = baseFinding({
      code: 'SyntheticLocatable',
      category: 'other',
      severity: 'negative',
      scoreImpact: -20,
      confidence: 0.95,
      evidence: ['lib/foo.dart'],
      evidenceItems: [
        {
          file: 'lib/foo.dart',
          line: null,
          column: null,
          symbol: null,
          astNode: null,
          analyzer: 'test',
          confidence: 0.95,
          source: 'heuristic',
          detail: 'lib/foo.dart',
        },
      ],
    });
    expect(deriveFindingPriority(f)).toBe('critical');
  });

  it('keeps critical when finding.file itself is set (no evidenceItems needed)', () => {
    const f = baseFinding({
      code: 'SyntheticFileField',
      category: 'other',
      severity: 'negative',
      scoreImpact: -20,
      confidence: 0.95,
      file: 'lib/bar.dart',
    });
    expect(deriveFindingPriority(f)).toBe('critical');
  });
});

/**
 * Reconciled 'high' threshold — the union of the two formulas that used to
 * disagree (project-report-builder.ts's old local deriveFindingPriority,
 * which only checked impact >= 8, and recommendation-engine.ts's old
 * derivePriority, which also accepted confidence >= 0.9 alone). See Bug 5
 * in data-reconciliation-bugs.test.ts for the end-to-end
 * explain_finding/explore_finding reproduction this unit-level suite backs.
 */
describe('deriveFindingPriority — reconciled "high" threshold (impact OR confidence)', () => {
  it('impact >= 8 alone triggers high, even with low confidence', () => {
    const f = baseFinding({
      code: 'HighImpactLowConfidence',
      category: 'other',
      severity: 'negative',
      scoreImpact: -8,
      confidence: 0.5,
    });
    expect(deriveFindingPriority(f)).toBe('high');
  });

  it('confidence >= 0.9 alone triggers high, even with low impact (the DebugPrint case)', () => {
    const f = baseFinding({
      code: 'LowImpactHighConfidence',
      category: 'other',
      severity: 'negative',
      scoreImpact: -4,
      confidence: 0.95,
    });
    expect(deriveFindingPriority(f)).toBe('high');
  });

  it('neither impact >= 8 nor confidence >= 0.9 does not trigger high', () => {
    const f = baseFinding({
      code: 'LowImpactLowConfidence',
      category: 'other',
      severity: 'negative',
      scoreImpact: -4,
      confidence: 0.7,
    });
    const result = deriveFindingPriority(f);
    expect(result).not.toBe('high');
    expect(result).not.toBe('critical');
  });

  it('high impact/confidence together without locatable evidence is capped at high, never critical', () => {
    const f = baseFinding({
      code: 'HighBothNoEvidence',
      category: 'other',
      severity: 'negative',
      scoreImpact: -12,
      confidence: 0.9,
      evidence: ['count=42'],
    });
    expect(deriveFindingPriority(f)).toBe('high');
  });
});

describe('evidence coverage — sampleFiles generalized beyond GodClassCandidate', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  function buildStack(storePath: string) {
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const logger = new SilentLogger();
    const ast = new AstAdapter(unavailableDartClient(), new HeuristicSymbolExtractor(), logger);
    const scanner = new ProjectScanner(ast, new SilentLogger());
    const codeQuality = new CodeQualityAnalyzer(refs);
    const stateManagement = new StateManagementAnalyzer(refs);
    const architecture = new ArchitectureAnalyzer(refs);
    const complexity = new ComplexityAnalyzer(refs);
    const testing = new TestingAnalyzer(refs);
    const dependency = new DependencyAnalyzer(refs);
    const performance = new PerformanceAnalyzer(refs);
    const documentation = new DocumentationAnalyzer(refs);
    const accessibility = new AccessibilityAnalyzer(refs);
    const metrics = new MetricsEngine();
    const evidence = new EvidenceEngine();
    const knowledge = new KnowledgeEngine(store);
    const relationships = new FindingRelationshipEngine();
    const scoring = new ScoringEngine();
    const health = new ProjectHealthScorer(scoring);
    const recommendations = new RecommendationEngine(knowledge, relationships);
    const explanation = new ExplanationEngine(recommendations, knowledge, relationships);
    const debt = new TechnicalDebtEngine();
    const archMatch = new ArchitectureMatchEngine();
    const priority = new PriorityActionEngine();
    const rules = new RuleEngine();
    const reports = new ProjectReportBuilder(
      scanner,
      codeQuality,
      stateManagement,
      architecture,
      metrics,
      explanation,
      recommendations,
      health,
      rules,
      evidence,
      knowledge,
      relationships,
      debt,
      archMatch,
      priority,
      complexity,
      testing,
      dependency,
      performance,
      documentation,
      accessibility,
    );
    const sessions = new AnalysisSessionStore(
      { repositoriesRoot: tempDir!, indexPath: storePath, indexOnUpdate: false },
      reports,
      logger,
    );
    return { store, reports, sessions, explanation };
  }

  /**
   * Deliberately dense across analyzers, mirroring the real NLDCMobileApp
   * review that surfaced this bug: a god class, a large build method, an
   * undocumented widget, a Presentation->Data layer violation (triggers both
   * ArchitectureAnalyzer's PresentationImportsData and DependencyAnalyzer's
   * LayerViolations from the same import), a Domain->Data violation, a
   * circular import, a setState-heavy file, and a huge (>=600 LOC) widget —
   * plus no tests and no Semantics usage anywhere, to exercise the
   * genuinely-evidence-less findings too.
   */
  async function createEvidenceCoverageApp(): Promise<string> {
    tempDir = await createTempDir('evidence-coverage-');
    const project = path.join(tempDir, 'app');
    await mkdir(path.join(project, 'lib', 'core'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'home', 'presentation'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'home', 'data'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'home', 'domain'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'widgets'), { recursive: true });

    await writeFile(
      path.join(project, 'pubspec.yaml'),
      `name: evidence_app\nversion: 1.0.0\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n`,
      'utf8',
    );

    // Circular import.
    await writeFile(
      path.join(project, 'lib', 'core', 'circular_a.dart'),
      "import './circular_b.dart';\n\nclass CircularA { CircularB? b; }\n",
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'core', 'circular_b.dart'),
      "import './circular_a.dart';\n\nclass CircularB { CircularA? a; }\n",
      'utf8',
    );

    // God class: >=400 LOC, 25 methods, 20 fields, 20 imports (score >= 70).
    const methodLines = Array.from({ length: 25 }, (_, i) => `  void method${i}() {}`).join('\n');
    const fieldLines = Array.from({ length: 20 }, (_, i) => `  final int field${i} = ${i};`).join('\n');
    const padLines = Array.from({ length: 350 }, () => '  // pad').join('\n');
    const bigImports = [
      'package:flutter/material.dart', 'package:flutter/widgets.dart', 'dart:async', 'dart:convert',
      'dart:io', 'dart:math', 'dart:collection', 'dart:typed_data', 'dart:isolate', 'dart:ffi',
      'dart:developer', 'package:flutter/foundation.dart', 'package:flutter/rendering.dart',
      'package:flutter/scheduler.dart', 'package:flutter/services.dart', 'package:flutter/painting.dart',
      'package:flutter/gestures.dart', 'package:flutter/semantics.dart', 'package:flutter/physics.dart',
      'package:flutter/animation.dart',
    ].map((i) => `import '${i}';`).join('\n');
    await writeFile(
      path.join(project, 'lib', 'core', 'big_service.dart'),
      `${bigImports}\n\nclass BigService {\n${methodLines}\n${fieldLines}\n${padLines}\n}\n`,
      'utf8',
    );

    // Large build method + Presentation -> Data import (PresentationImportsData
    // + LayerViolations, from the same import edge) + undocumented widget.
    const textLines = Array.from({ length: 90 }, (_, i) => `      Text('line ${i}'),`).join('\n');
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'presentation', 'home_page.dart'),
      `import 'package:flutter/material.dart';\nimport '../data/home_repository.dart';\n\nclass HomePage extends StatefulWidget {\n  const HomePage({super.key});\n  @override\n  State<HomePage> createState() => _HomePageState();\n}\n\nclass _HomePageState extends State<HomePage> {\n  final repo = HomeRepository();\n  @override\n  Widget build(BuildContext context) {\n    return Column(children: [\n${textLines}\n    ]);\n  }\n}\n`,
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'data', 'home_repository.dart'),
      'class HomeRepository { Future<void> load() async {} }\n',
      'utf8',
    );

    // Domain -> Data import.
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'domain', 'home_usecase.dart'),
      "import '../data/home_repository.dart';\n\nclass HomeUsecase { final repo = HomeRepository(); }\n",
      'utf8',
    );

    // Heavy/problematic setState: 41 setState() calls in a file that also
    // touches http — isProblematicSetStateContext() flags the whole file, so
    // all 41 count toward problematicSetStateSites. scoreImpact is
    // -(4 + floor(n/10)) capped at 12, so 41 sites crosses the high-impact
    // (>=8) threshold, not just the >10 finding-emission threshold.
    const setStateCalls = Array.from({ length: 41 }, () => '    setState(() {});').join('\n');
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'presentation', 'heavy_state.dart'),
      `import 'package:flutter/material.dart';\nimport 'package:http/http.dart' as http;\n\nclass HeavyStatePage extends StatefulWidget {\n  const HeavyStatePage({super.key});\n  @override\n  State<HeavyStatePage> createState() => _HeavyStatePageState();\n}\n\nclass _HeavyStatePageState extends State<HeavyStatePage> {\n  Future<void> load() async {\n    await http.get(Uri.parse('https://example.com'));\n${setStateCalls}\n  }\n\n  @override\n  Widget build(BuildContext context) => Container();\n}\n`,
      'utf8',
    );

    // Huge widget: file >= 600 LOC, undocumented.
    const hugePad = Array.from({ length: 615 }, () => '// pad').join('\n');
    await writeFile(
      path.join(project, 'lib', 'widgets', 'huge_widget.dart'),
      `import 'package:flutter/material.dart';\n\nclass HugeWidget extends StatelessWidget {\n  const HugeWidget({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return Container();\n  }\n}\n${hugePad}\n`,
      'utf8',
    );

    // Deliberately: no test/ directory, no Semantics/Tooltip usage anywhere.
    return project;
  }

  it('populates real sampleFiles for every finding whose evidence names a real file', async () => {
    const project = await createEvidenceCoverageApp();
    const { store, reports } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const report = await reports.build(project);

    const byCode = new Map(report.findings.map((f) => [f.code, f]));

    // Confirmed working before this change (GodClassCandidate was Bug 3's
    // fix; the other three already matched the generic parser's shapes).
    const previouslyWorking = ['GodClassCandidate', 'LargeBuildMethod', 'UndocumentedWidgets'];
    // Fixed by this change: general arrow-chain parsing in evidence-engine.ts.
    const newlyFixed = ['LayerViolations', 'CircularDependencies'];
    // Already worked via existing evidence-engine.ts special cases.
    const alreadySpecialCased = ['PresentationImportsData', 'DomainImportsData'];

    for (const code of [...previouslyWorking, ...newlyFixed, ...alreadySpecialCased]) {
      const f = byCode.get(code);
      expect(f, `fixture must trigger ${code}`).toBeDefined();
      const files = sampleFilesFor(f);
      expect(files.length, `${code} should have real sampleFiles`).toBeGreaterThan(0);
      // Every sample path must be a real project-relative .dart file — not a
      // whole evidence sentence (regression guard for the CircularDependencies
      // "cycle.split(' -> ')" bug where the wrong separator meant the entire
      // cycle description string was stored as if it were a single file).
      for (const file of files) {
        expect(file.endsWith('.dart')).toBe(true);
        expect(file).not.toContain(' → ');
        expect(file).not.toContain(' (');
      }
    }

    // CircularDependencies must specifically resolve to real per-file paths
    // pulled from the cycle chain, not the whole chain string.
    const circular = byCode.get('CircularDependencies')!;
    for (const file of sampleFilesFor(circular)) {
      expect(project).toBeDefined(); // fixture built successfully
      expect(file).toMatch(/^lib\/core\/circular_[ab]\.dart$/);
    }

    store.close();
  });

  it('flags genuinely evidence-less high-impact findings instead of faking sampleFiles', async () => {
    const project = await createEvidenceCoverageApp();
    const { store, reports } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const report = await reports.build(project);
    const byCode = new Map(report.findings.map((f) => [f.code, f]));

    // These findings, as currently computed by their analyzers, only ever
    // produce aggregate counts — no per-instance file is tracked anywhere in
    // the pipeline. They must not silently claim 'critical' and must not
    // have fabricated sampleFiles.
    const evidenceLessHighImpact = ['HeavySetState', 'HugeWidgets', 'NoSemanticsWidgets', 'NoTestSuite'];
    for (const code of evidenceLessHighImpact) {
      const f = byCode.get(code);
      expect(f, `fixture must trigger ${code}`).toBeDefined();
      const impact = Math.abs(f!.scoreImpact ?? 0);
      expect(impact, `${code} must actually be high/critical-impact for this test to mean anything`).toBeGreaterThanOrEqual(8);
      expect(sampleFilesFor(f)).toEqual([]);
      expect(f!.priority).not.toBe('critical');
    }

    store.close();
  });

  it('review_project topRisks/topActions surface hasLocatableEvidence alongside sampleFiles', async () => {
    const project = await createEvidenceCoverageApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(
      sessions,
      new SilentLogger(),
      new ExplainFindingHandler(sessions, explanation),
    ).execute({ path: project });
    expect(review.success).toBe(true);
    if (review.success && 'topRisks' in review.data) {
      const layerRisk = review.data.topRisks.find((r) => r.title.includes('layer violation'));
      expect(layerRisk, 'LayerViolations must appear in topRisks').toBeDefined();
      expect(layerRisk!.hasLocatableEvidence).toBe(true);
      expect(layerRisk!.sampleFiles.length).toBeGreaterThan(0);

      const noSemanticsRisk = review.data.topRisks.find((r) => r.title.includes('Semantics'));
      if (noSemanticsRisk) {
        expect(noSemanticsRisk.hasLocatableEvidence).toBe(false);
        expect(noSemanticsRisk.sampleFiles).toEqual([]);
      }
    }
    store.close();
  });
});

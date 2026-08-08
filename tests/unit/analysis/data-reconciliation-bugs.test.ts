import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AstAdapter } from '../../../src/analysis/ast/ast-adapter.js';
import { TechnicalDebtEngine } from '../../../src/analysis/debt/technical-debt-engine.js';
import { AccessibilityAnalyzer } from '../../../src/analysis/engines/accessibility-analyzer.js';
import { ArchitectureAnalyzer } from '../../../src/analysis/engines/architecture-analyzer.js';
import type { ArchitectureFacts } from '../../../src/analysis/engines/architecture-analyzer.js';
import { ArchitectureMatchEngine } from '../../../src/analysis/engines/architecture-match-engine.js';
import { CodeQualityAnalyzer } from '../../../src/analysis/engines/code-quality-analyzer.js';
import type { CodeQualityFacts } from '../../../src/analysis/engines/code-quality-analyzer.js';
import { ComplexityAnalyzer } from '../../../src/analysis/engines/complexity-analyzer.js';
import { DependencyAnalyzer } from '../../../src/analysis/engines/dependency-analyzer.js';
import { DocumentationAnalyzer } from '../../../src/analysis/engines/documentation-analyzer.js';
import { PerformanceAnalyzer } from '../../../src/analysis/engines/performance-analyzer.js';
import { StateManagementAnalyzer } from '../../../src/analysis/engines/state-management-analyzer.js';
import type { StateManagementFacts } from '../../../src/analysis/engines/state-management-analyzer.js';
import { TestingAnalyzer } from '../../../src/analysis/engines/testing-analyzer.js';
import { EvidenceEngine } from '../../../src/analysis/evidence/evidence-engine.js';
import { ExplanationEngine } from '../../../src/analysis/insight/explanation-engine.js';
import { PriorityActionEngine } from '../../../src/analysis/insight/priority-action-engine.js';
import { ProjectHealthScorer } from '../../../src/analysis/insight/project-health-scorer.js';
import { ProjectReportBuilder } from '../../../src/analysis/insight/project-report-builder.js';
import { RecommendationEngine } from '../../../src/analysis/insight/recommendation-engine.js';
import { KnowledgeEngine } from '../../../src/analysis/knowledge/knowledge-engine.js';
import { MetricsEngine } from '../../../src/analysis/metrics/metrics-engine.js';
import { OfficialReferenceResolver } from '../../../src/analysis/official-refs.js';
import { ProjectScanner } from '../../../src/analysis/project-scanner.js';
import { FindingRelationshipEngine } from '../../../src/analysis/relationships/finding-relationship-engine.js';
import { RuleEngine } from '../../../src/analysis/rules/rule-engine.js';
import {
  checkArchitectureAgreement,
  checkScoreClampSanity,
} from '../../../src/analysis/session/summary-views.js';
import { ScoringEngine } from '../../../src/analysis/scoring/scoring-engine.js';
import type { AnalysisFinding, ProjectMetrics, ProjectSnapshot } from '../../../src/analysis/types.js';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { HeuristicSymbolExtractor } from '../../../src/parser/heuristic-extractor.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import { AnalysisSessionStore } from '../../../src/analysis/session/analysis-session-store.js';
import { AnalyzeArchitectureHandler } from '../../../src/tools/analyze-architecture.js';
import { ReviewProjectHandler } from '../../../src/tools/review-project.js';
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

function minimalSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    projectPath: '/tmp/fixture',
    hasPubspec: true,
    pubspecRaw: null,
    packageName: 'fixture',
    dependencies: [],
    devDependencies: [],
    isFlutterProject: true,
    hasAnalysisOptions: true,
    libExists: true,
    testExists: false,
    topLevelDirs: [],
    libDirs: [],
    dartFiles: [],
    symbols: [],
    importEdges: [],
    astMeta: {
      source: 'heuristic',
      coverage: 'full',
      filesAnalyzed: 0,
      filesTotal: 0,
      baseConfidence: 0.75,
    },
    ...overrides,
  };
}

function minimalMetrics(overrides: Partial<ProjectMetrics> = {}): ProjectMetrics {
  return {
    dartFileCount: 0,
    libFileCount: 0,
    testFileCount: 0,
    widgetCount: 0,
    classCount: 0,
    mixinCount: 0,
    extensionCount: 0,
    enumCount: 0,
    featureCount: 0,
    packageDependencyCount: 0,
    linesOfCode: 0,
    symbolCount: 0,
    ...overrides,
  };
}

function minimalArchitectureFacts(overrides: Partial<ArchitectureFacts> = {}): ArchitectureFacts {
  return {
    detectedArchitecture: 'unknown',
    confidence: 30,
    libDirs: [],
    featureDirCount: 0,
    hasDomain: false,
    hasData: false,
    hasPresentation: false,
    hasCore: false,
    hasShared: false,
    hasFeatures: false,
    presentationImportsData: false,
    domainImportsFlutter: false,
    domainImportsData: false,
    circularDependencies: [],
    testFileCount: 0,
    libFileCount: 0,
    dependencyDirectionSummary: 'undetermined',
    evidence: [],
    maintainabilityScore: 50,
    scalabilityScore: 50,
    ...overrides,
  };
}

function minimalCodeQualityFacts(overrides: Partial<CodeQualityFacts> = {}): CodeQualityFacts {
  return {
    dartFileCount: 0,
    widgetCount: 0,
    classCount: 0,
    mixinCount: 0,
    extensionCount: 0,
    largeClassCandidates: [],
    godClassCandidates: [],
    godClassDetails: [],
    deepInheritance: [],
    largeBuildMethods: [],
    printCallSites: 0,
    legacyButtonUsages: 0,
    missingConstCandidates: 0,
    undocumentedWidgets: 0,
    usesSealedOrFinalClassKeywords: false,
    usesPatternMatching: false,
    listMapSetUsage: { list: 0, map: 0, set: 0 },
    ...overrides,
  };
}

function minimalStateManagementFacts(
  overrides: Partial<StateManagementFacts> = {},
): StateManagementFacts {
  return {
    detectedApproaches: [],
    dependencySignals: [],
    setStateCallSites: 0,
    localSetStateSites: 0,
    problematicSetStateSites: 0,
    statefulWidgetCount: 0,
    changeNotifierCount: 0,
    providerScopeHints: 0,
    riverpodHints: 0,
    blocHints: 0,
    getxHints: 0,
    globalMutableCandidates: 0,
    disposeMethodCount: 0,
    controllerFieldHints: 0,
    businessLogicInWidgetsHints: 0,
    featuresWithMixedLibraries: [],
    maintainabilityScore: 50,
    scalabilityScore: 50,
    ...overrides,
  };
}

function baseFinding(overrides: Partial<AnalysisFinding> & Pick<AnalysisFinding, 'code' | 'category' | 'severity' | 'scoreImpact' | 'confidence'>): AnalysisFinding {
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

describe('Bug 1 — codeQuality score double-counting via shared flutter/dart categories', () => {
  it('excludes performance/accessibility/documentation findings from codeQuality but keeps its own + complexity findings', () => {
    const scoring = new ScoringEngine();

    const findings: AnalysisFinding[] = [
      // CodeQualityAnalyzer's own findings — should count.
      baseFinding({ code: 'UsesMixins', category: 'oop', severity: 'positive', scoreImpact: 2, confidence: 1 }),
      baseFinding({ code: 'GodClassCandidate', category: 'solid', severity: 'negative', scoreImpact: -14, confidence: 1 }),
      // ComplexityAnalyzer — no dedicated score component, should count.
      baseFinding({ code: 'HugeWidgets', category: 'flutter', severity: 'negative', scoreImpact: -8, confidence: 1 }),
      // PerformanceAnalyzer, AccessibilityAnalyzer, DocumentationAnalyzer —
      // each already has its own dedicated score component; must NOT be
      // double-counted into codeQuality even though they share categories.
      baseFinding({ code: 'LargeBuildMethod', category: 'flutter', severity: 'negative', scoreImpact: -15, confidence: 1 }),
      baseFinding({ code: 'ImagesWithoutSemanticLabels', category: 'flutter', severity: 'negative', scoreImpact: -20, confidence: 1 }),
      baseFinding({ code: 'UndocumentedWidgets', category: 'flutter', severity: 'negative', scoreImpact: -25, confidence: 1 }),
    ];

    const report = scoring.score({
      snapshot: minimalSnapshot(),
      metrics: minimalMetrics(),
      findings,
      architecture: minimalArchitectureFacts(),
      codeQuality: minimalCodeQualityFacts(),
      stateManagement: minimalStateManagementFacts(),
    });

    const codeQuality = report.scores.find((s) => s.id === 'codeQuality')!;
    // base 70 + 2 (UsesMixins) - 14 (GodClassCandidate) - 8 (HugeWidgets) = 50.
    // The performance/accessibility/documentation findings (-15/-20/-25) must
    // NOT be subtracted here — they belong to their own score components.
    expect(codeQuality.value).toBe(50);
    expect(codeQuality.clamped).toBeFalsy();
    expect(codeQuality.negativeContributors?.some((c) => c.findingCode === 'LargeBuildMethod')).toBe(
      false,
    );
    expect(
      codeQuality.negativeContributors?.some((c) => c.findingCode === 'ImagesWithoutSemanticLabels'),
    ).toBe(false);
    expect(
      codeQuality.negativeContributors?.some((c) => c.findingCode === 'UndocumentedWidgets'),
    ).toBe(false);
    expect(codeQuality.negativeContributors?.some((c) => c.findingCode === 'GodClassCandidate')).toBe(
      true,
    );
    expect(codeQuality.negativeContributors?.some((c) => c.findingCode === 'HugeWidgets')).toBe(true);
  });

  it('marks a floor-clamped score as clamped and reports the pre-clamp raw value', () => {
    const scoring = new ScoringEngine();
    const findings: AnalysisFinding[] = [
      baseFinding({ code: 'UsesMixins', category: 'oop', severity: 'positive', scoreImpact: 2, confidence: 1 }),
      baseFinding({ code: 'GodClassCandidate', category: 'solid', severity: 'negative', scoreImpact: -15, confidence: 1 }),
      baseFinding({ code: 'DeepInheritance', category: 'oop', severity: 'negative', scoreImpact: -6, confidence: 1 }),
      baseFinding({ code: 'DebugPrint', category: 'flutter', severity: 'negative', scoreImpact: -4, confidence: 1 }),
      baseFinding({ code: 'LargeClassCandidate', category: 'solid', severity: 'negative', scoreImpact: -2, confidence: 1 }),
      baseFinding({ code: 'HighComplexityFiles', category: 'flutter', severity: 'warning', scoreImpact: -50, confidence: 1 }),
    ];

    const report = scoring.score({
      snapshot: minimalSnapshot(),
      metrics: minimalMetrics(),
      findings,
      architecture: minimalArchitectureFacts(),
      codeQuality: minimalCodeQualityFacts(),
      stateManagement: minimalStateManagementFacts(),
    });

    const codeQuality = report.scores.find((s) => s.id === 'codeQuality')!;
    // 70 + 2 - 15 - 6 - 4 - 2 - 50 = -5 -> clamped to 0.
    expect(codeQuality.value).toBe(0);
    expect(codeQuality.clamped).toBe(true);
    expect(codeQuality.rawValue).toBe(-5);
    expect(codeQuality.inputsUsed.some((i) => i.includes('clamped from raw -5 to 0'))).toBe(true);
  });

  it('does not mark an un-clamped score as clamped', () => {
    const scoring = new ScoringEngine();
    const findings: AnalysisFinding[] = [
      baseFinding({ code: 'UsesMixins', category: 'oop', severity: 'positive', scoreImpact: 2, confidence: 1 }),
    ];
    const report = scoring.score({
      snapshot: minimalSnapshot(),
      metrics: minimalMetrics(),
      findings,
      architecture: minimalArchitectureFacts(),
      codeQuality: minimalCodeQualityFacts(),
      stateManagement: minimalStateManagementFacts(),
    });
    const codeQuality = report.scores.find((s) => s.id === 'codeQuality')!;
    expect(codeQuality.value).toBe(72);
    expect(codeQuality.clamped).toBeFalsy();
    expect(codeQuality.rawValue).toBeUndefined();
  });
});

describe('Bug 4 — dataQuality consistency checks (unit-level)', () => {
  it('flags a score clamped to 0 despite net-positive listed contributors', () => {
    const warnings = checkScoreClampSanity([
      {
        id: 'codeQuality',
        label: 'Code Quality',
        value: 0,
        max: 100,
        calculation: '',
        inputsUsed: [],
        positiveContributors: [{ label: 'a', delta: 15 }],
        negativeContributors: [{ label: 'b', delta: -5 }],
        clamped: true,
        rawValue: -83,
      },
    ]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/clamped to 0/);
  });

  it('does not flag a clamped score whose negatives genuinely explain the floor', () => {
    const warnings = checkScoreClampSanity([
      {
        id: 'codeQuality',
        label: 'Code Quality',
        value: 0,
        max: 100,
        calculation: '',
        inputsUsed: [],
        positiveContributors: [{ label: 'a', delta: 5 }],
        negativeContributors: [{ label: 'b', delta: -90 }],
        clamped: true,
        rawValue: -85,
      },
    ]);
    expect(warnings.length).toBe(0);
  });

  it('does not flag a score that was not clamped at all', () => {
    const warnings = checkScoreClampSanity([
      {
        id: 'codeQuality',
        label: 'Code Quality',
        value: 0,
        max: 100,
        calculation: '',
        inputsUsed: [],
        positiveContributors: [{ label: 'a', delta: 90 }],
        negativeContributors: [],
        clamped: false,
      },
    ]);
    expect(warnings.length).toBe(0);
  });

  it('flags a DetectedArchitecture finding that disagrees with the authoritative match', () => {
    const warnings = checkArchitectureAgreement({
      findings: [
        baseFinding({
          code: 'DetectedArchitecture',
          category: 'architecture',
          severity: 'info',
          scoreImpact: 0,
          confidence: 0.7,
          title: 'Detected architecture: layered',
        }),
      ],
      architectureDetection: {
        detected: { architecture: 'feature_first', confidence: 80, evidence: [] },
        alternatives: [],
        missingComponents: [],
        folderStructure: [],
        dependencyDirection: '',
      },
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/disagreement/i);
  });

  it('does not flag agreement between the finding and the authoritative match', () => {
    const warnings = checkArchitectureAgreement({
      findings: [
        baseFinding({
          code: 'DetectedArchitecture',
          category: 'architecture',
          severity: 'info',
          scoreImpact: 0,
          confidence: 0.8,
          title: 'Detected architecture: feature_first',
        }),
      ],
      architectureDetection: {
        detected: { architecture: 'feature_first', confidence: 80, evidence: [] },
        alternatives: [],
        missingComponents: [],
        folderStructure: [],
        dependencyDirection: '',
      },
    });
    expect(warnings.length).toBe(0);
  });
});

/**
 * Full-pipeline fixtures for Bugs 2 & 3 (and Bug 4's no-false-positive
 * assertion), exercised through the real DI stack the same way
 * analyzers.test.ts does — not hand-constructed facts — because these two
 * bugs are about disagreement/loss between real engines wired together.
 */
describe('Bug 2 & 3 — full pipeline regressions', () => {
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
    return { store, reports, sessions };
  }

  /**
   * Layered folders (domain+data+presentation, with a Presentation->Data
   * violation) *and* a features/ tree with 2+ feature dirs. ArchitectureAnalyzer's
   * own single-candidate classifier checks the layered branch first and
   * returns early (layered/70%), never reaching the feature_first check.
   * ArchitectureMatchEngine scores ALL matching candidates and picks the
   * highest-confidence one (feature_first/80%) — the exact disagreement
   * from the real NLDCMobileApp run this bug was found on.
   */
  async function createLayeredAndFeatureFirstApp(): Promise<string> {
    tempDir = await createTempDir('arch-disagreement-');
    const project = path.join(tempDir, 'app');
    await mkdir(path.join(project, 'lib', 'domain'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'data'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'presentation'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'auth'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'home'), { recursive: true });
    await writeFile(
      path.join(project, 'pubspec.yaml'),
      `name: arch_app\nversion: 1.0.0\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n`,
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'domain', 'entity.dart'),
      'class Entity { final String id; const Entity(this.id); }\n',
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'data', 'repo.dart'),
      'class Repo { Future<void> load() async {} }\n',
      'utf8',
    );
    // Presentation -> Data import: the layer violation that pushes
    // ArchitectureAnalyzer's own classifier into its early-return 'layered' branch.
    await writeFile(
      path.join(project, 'lib', 'presentation', 'screen.dart'),
      "import '../data/repo.dart';\n\nclass Screen { final repo = Repo(); }\n",
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'features', 'auth', 'auth.dart'),
      'class AuthFeature {}\n',
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'home.dart'),
      'class HomeFeature {}\n',
      'utf8',
    );
    return project;
  }

  it('review_project narrative and analyze_architecture detected agree on the primary pattern', async () => {
    const project = await createLayeredAndFeatureFirstApp();
    const { store, reports, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const report = await reports.build(project);
    // Sanity: this fixture really does trigger the disagreement condition —
    // ArchitectureMatchEngine's authoritative pick differs from what
    // ArchitectureAnalyzer's own single-candidate guess would have been.
    expect(report.architectureDetection.detected.architecture).toBe('feature_first');
    expect(report.architectureDetection.alternatives.some((a) => a.architecture === 'layered')).toBe(
      true,
    );

    // The narrative (used by review_project's overview + architecture text)
    // must reflect the SAME authoritative pattern, not ArchitectureAnalyzer's
    // own raw guess.
    expect(report.insight.overview).toContain('feature_first');
    expect(report.insight.overview).not.toContain('Closest matching architecture: layered');
    expect(report.insight.architecture).toContain('feature_first');

    // The DetectedArchitecture finding (shown in review_project's
    // findingCodes and topRisks/strengths) must also agree.
    const detectedFinding = report.findings.find((f) => f.code === 'DetectedArchitecture')!;
    expect(detectedFinding.title).toContain('feature_first');

    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (review.success && 'overallHealth' in review.data) {
      expect(review.data.overview).toContain('feature_first');
      expect(review.data.dataQualityWarnings).toBeUndefined();

      const arch = await new AnalyzeArchitectureHandler(sessions).execute({
        sessionId: review.data.sessionId,
      });
      expect(arch.success).toBe(true);
      if (arch.success && 'detected' in arch.data) {
        expect(arch.data.detected).toBe('feature_first');
        expect(review.data.overview).toContain(arch.data.detected);
      }
    }
    store.close();
  });

  /** Same big-class shape used by no-duplicate-finding-codes.test.ts's dense fixture. */
  async function createGodClassApp(): Promise<string> {
    tempDir = await createTempDir('god-class-');
    const project = path.join(tempDir, 'app');
    await mkdir(path.join(project, 'lib', 'core'), { recursive: true });
    await writeFile(
      path.join(project, 'pubspec.yaml'),
      `name: god_class_app\nversion: 1.0.0\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n`,
      'utf8',
    );
    const methodLines = Array.from({ length: 25 }, (_, i) => `  void method${i}() {}`).join('\n');
    const fieldLines = Array.from({ length: 20 }, (_, i) => `  final int field${i} = ${i};`).join('\n');
    const padLines = Array.from({ length: 350 }, () => '  // pad').join('\n');
    const imports = [
      'package:flutter/material.dart',
      'package:flutter/widgets.dart',
      'dart:async',
      'dart:convert',
      'dart:io',
      'dart:math',
      'dart:collection',
      'dart:typed_data',
      'dart:isolate',
      'dart:ffi',
      'dart:developer',
      'package:flutter/foundation.dart',
      'package:flutter/rendering.dart',
      'package:flutter/scheduler.dart',
      'package:flutter/services.dart',
      'package:flutter/painting.dart',
      'package:flutter/gestures.dart',
      'package:flutter/semantics.dart',
      'package:flutter/physics.dart',
      'package:flutter/animation.dart',
    ]
      .map((i) => `import '${i}';`)
      .join('\n');
    await writeFile(
      path.join(project, 'lib', 'core', 'big_service.dart'),
      `${imports}\n\nclass BigService {\n${methodLines}\n${fieldLines}\n${padLines}\n}\n`,
      'utf8',
    );
    return project;
  }

  it('GodClassCandidate topRisk/topAction gets non-empty sampleFiles from real evidence', async () => {
    const project = await createGodClassApp();
    const { store, reports, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const report = await reports.build(project);
    const godClass = report.findings.find((f) => f.code === 'GodClassCandidate');
    expect(godClass, 'fixture must actually trigger GodClassCandidate').toBeDefined();
    expect(godClass!.evidenceItems?.some((i) => i.file === 'lib/core/big_service.dart')).toBe(true);

    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (review.success && 'topRisks' in review.data) {
      const godClassRisk = review.data.topRisks.find((r) => r.title.includes('God class'));
      expect(godClassRisk, 'GodClassCandidate must appear in topRisks').toBeDefined();
      expect(godClassRisk!.hasEvidence).toBe(true);
      expect(godClassRisk!.sampleFiles.length).toBeGreaterThan(0);
      expect(godClassRisk!.sampleFiles).toContain('lib/core/big_service.dart');
    }

    store.close();
  });
});

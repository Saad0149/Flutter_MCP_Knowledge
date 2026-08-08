import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { IntendedBehaviourEngine } from '../../../src/analysis/insight/intended-behaviour-engine.js';
import { KnowledgeBaseReadinessChecker } from '../../../src/repository/knowledge-base-readiness.js';
import type { RepositoryManager } from '../../../src/repository/types.js';
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
import { ScoringEngine } from '../../../src/analysis/scoring/scoring-engine.js';
import { buildAnalysisSummary } from '../../../src/analysis/types.js';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { HeuristicSymbolExtractor } from '../../../src/parser/heuristic-extractor.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import { AnalysisSessionStore } from '../../../src/analysis/session/analysis-session-store.js';
import { AnalyzeArchitectureHandler } from '../../../src/tools/analyze-architecture.js';
import { AnalyzeCodeQualityHandler } from '../../../src/tools/analyze-code-quality.js';
import { AnalyzeStateManagementHandler } from '../../../src/tools/analyze-state-management.js';
import { AnalyzeComplexityHandler } from '../../../src/tools/analyze-complexity.js';
import { AnalyzeDocumentationHandler } from '../../../src/tools/analyze-documentation.js';
import { AnalyzeTestingHandler } from '../../../src/tools/analyze-testing.js';
import { AnalyzeDependenciesHandler } from '../../../src/tools/analyze-dependencies.js';
import { AnalyzePerformanceHandler } from '../../../src/tools/analyze-performance.js';
import { AnalyzeAccessibilityHandler } from '../../../src/tools/analyze-accessibility.js';
import { ExplainFindingHandler } from '../../../src/tools/explain-finding.js';
import { ExploreFindingHandler } from '../../../src/tools/explore-finding.js';
import { FindIntendedBehaviorHandler } from '../../../src/tools/find-intended-behavior.js';
import { ReviewProjectHandler } from '../../../src/tools/review-project.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

describe('Analysis engines + MCP tools (v0.7 analysis sessions)', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  async function createFixtureApp(): Promise<string> {
    tempDir = await createTempDir('analysis-');
    const project = path.join(tempDir, 'app');
    await mkdir(path.join(project, 'lib', 'features', 'home', 'presentation'), {
      recursive: true,
    });
    await mkdir(path.join(project, 'lib', 'features', 'home', 'domain'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'home', 'data'), { recursive: true });
    await writeFile(
      path.join(project, 'pubspec.yaml'),
      `name: demo_app
description: fixture
version: 1.0.0
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
  provider: ^6.0.0
`,
      'utf8',
    );
    await writeFile(
      path.join(project, 'analysis_options.yaml'),
      'include: package:flutter_lints/flutter.yaml\n',
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'presentation', 'home_page.dart'),
      `import 'package:flutter/material.dart';
import '../data/home_repository.dart';

/// Home screen.
class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final controller = TextEditingController();
  final repo = HomeRepository();
  @override
  Widget build(BuildContext context) {
    print('building');
    return RaisedButton(onPressed: () {}, child: const Text('Go'));
  }
}
`,
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'domain', 'home_entity.dart'),
      'class HomeEntity { final String id; const HomeEntity(this.id); }\n',
      'utf8',
    );
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'data', 'home_repository.dart'),
      'class HomeRepository { Future<void> load() async {} }\n',
      'utf8',
    );
    return project;
  }

  /** Produces `count` files each with an oversized build() method, so a single
   * LargeBuildMethod finding ends up with `count` evidence items — enough to
   * exercise real maxEvidence truncation end-to-end. */
  async function createFixtureAppWithManyLargeBuildMethods(count: number): Promise<string> {
    tempDir = await createTempDir('analysis-large-build-');
    const project = path.join(tempDir, 'app');
    const libDir = path.join(project, 'lib');
    await mkdir(libDir, { recursive: true });
    await writeFile(
      path.join(project, 'pubspec.yaml'),
      `name: demo_app
description: fixture
version: 1.0.0
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
`,
      'utf8',
    );
    const textLines = Array.from(
      { length: 90 },
      (_, i) => `      Text('line ${i}'),`,
    ).join('\n');
    for (let i = 0; i < count; i += 1) {
      await writeFile(
        path.join(libDir, `widget_${i}.dart`),
        `import 'package:flutter/material.dart';

class Widget${i} extends StatelessWidget {
  const Widget${i}({super.key});
  @override
  Widget build(BuildContext context) {
    return Column(children: [
${textLines}
    ]);
  }
}
`,
        'utf8',
      );
    }
    return project;
  }

  /** A project directory with zero Dart files — for the fail-fast/blocked-session tests. */
  async function createEmptyFixtureApp(): Promise<string> {
    tempDir = await createTempDir('analysis-empty-');
    const project = path.join(tempDir, 'app');
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, 'README.md'),
      '# Not a Flutter project\n\nJust some docs, no lib/ or .dart files.\n',
      'utf8',
    );
    return project;
  }

  function unavailableDartClient(): DartAnalyzerClient {
    return {
      isAvailable: async () => false,
      analyzeFiles: async () => ({
        available: false,
        files: [],
        warning: 'Dart SDK or parser helper not available',
      }),
      getHelperPath: () => '',
      toInsertSymbols: () => [],
    } as unknown as DartAnalyzerClient;
  }

  function buildStack(storePath: string) {
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const logger = new SilentLogger();
    const dart = unavailableDartClient();
    const heuristic = new HeuristicSymbolExtractor();
    const ast = new AstAdapter(dart, heuristic, logger);
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
    return {
      store,
      reports,
      sessions,
      recommendations,
      explanation,
      scanner,
      codeQuality,
      architecture,
      stateManagement,
      knowledge,
      complexity,
      testing,
      dependency,
      performance,
      documentation,
      accessibility,
    };
  }

  it('AstAdapter falls back to heuristics with reduced confidence', async () => {
    const project = await createFixtureApp();
    const { store, scanner } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const snapshot = await scanner.scan(project);
    expect(snapshot.astMeta.source).toBe('heuristic');
    expect(snapshot.astMeta.baseConfidence).toBe(0.75);
    store.close();
  });

  it('enrichment adds structured evidence, relationships, and transparent scores', async () => {
    const project = await createFixtureApp();
    const { store, reports } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const report = await reports.build(project);

    expect(report.findings.every((f) => f.id)).toBe(true);
    expect(report.findings.every((f) => (f.evidenceItems?.length ?? 0) > 0 || f.evidence.length > 0)).toBe(
      true,
    );
    expect(report.findings.some((f) => f.code === 'PresentationImportsData')).toBe(true);
    const presentation = report.findings.find((f) => f.code === 'PresentationImportsData')!;
    expect(presentation.relatedFindingCodes?.length).toBeGreaterThan(0);

    const archScore = report.health.scores.find((s) => s.id === 'architecture')!;
    expect(archScore.positiveContributors?.length).toBeGreaterThan(0);
    expect(archScore.confidence).toBeGreaterThan(0);
    expect(archScore.inputsUsed.some((i) => i.startsWith('+') || i.startsWith('-'))).toBe(true);

    expect(report.technicalDebt.majorContributors.length).toBeGreaterThan(0);
    expect(report.technicalDebt.estimatedRefactoringCost).toMatch(/week/i);
    expect(report.topActions.length).toBeGreaterThan(0);
    expect(report.healthReport.topActions.length).toBeGreaterThan(0);
    expect(report.healthReport.topStrengths.length).toBeGreaterThan(0);

    store.close();
  });

  it('review_project returns slim executive summary + sessionId by default', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (review.success) {
      expect(review.data.sessionId).toMatch(/^[a-f0-9]{16}$/);
      expect('overallHealth' in review.data).toBe(true);
      expect('topRisks' in review.data).toBe(true);
      expect('healthReport' in review.data).toBe(false);
      expect('recommendations' in review.data).toBe(false);
      if ('overallHealth' in review.data) {
        expect(review.data.topRisks.length).toBeLessThanOrEqual(5);
        expect(review.data.findingCodes.length).toBeLessThanOrEqual(15);
        expect(review.data.usage.next).toMatch(/sessionId/);
      }
    }
    store.close();
  });

  it('review_project detail=full still returns legacy payload with sessionId', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
      detail: 'full',
    });
    expect(review.success).toBe(true);
    if (review.success) {
      expect(review.data.sessionId).toBeTruthy();
      expect('healthReport' in review.data).toBe(true);
      if ('healthReport' in review.data) {
        expect(review.data.healthReport.technicalDebt.length).toBeGreaterThan(10);
        expect(review.data.technicalDebt.breakdown).toBeDefined();
        expect(review.data.health.overall.positiveContributors?.length).toBeGreaterThan(0);
      }
    }
    store.close();
  });

  it('follow-up tools use sessionId without rescanning', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation, recommendations } = buildStack(
      path.join(tempDir!, 'k.sqlite'),
    );
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (!review.success || !('sessionId' in review.data)) {
      store.close();
      return;
    }
    const sessionId = review.data.sessionId;

    const arch = await new AnalyzeArchitectureHandler(sessions).execute({ sessionId });
    expect(arch.success).toBe(true);
    if (arch.success) {
      expect(arch.data.fromCache).toBe(true);
      expect(arch.data.sessionId).toBe(sessionId);
      expect(arch.data.score?.topPositives).toBeDefined();
      expect(arch.data.findings.every((f) => !('evidenceItems' in f))).toBe(true);
    }

    const quality = await new AnalyzeCodeQualityHandler(sessions).execute({ sessionId });
    expect(quality.success).toBe(true);
    if (quality.success) expect(quality.data.fromCache).toBe(true);

    const state = await new AnalyzeStateManagementHandler(sessions).execute({ sessionId });
    expect(state.success).toBe(true);
    if (state.success) expect(state.data.fromCache).toBe(true);

    const explained = await new ExplainFindingHandler(sessions, explanation).execute({
      sessionId,
      findingCode: 'PresentationImportsData',
    });
    expect(explained.success).toBe(true);
    if (explained.success) {
      expect(explained.data.fromCache).toBe(true);
      expect(explained.data.whyThisMatters!.length).toBeGreaterThan(20);
    }

    const explored = await new ExploreFindingHandler(sessions, recommendations).execute({
      sessionId,
      findingCode: 'PresentationImportsData',
    });
    expect(explored.success).toBe(true);
    if (explored.success) {
      expect(explored.data.fromCache).toBe(true);
      expect(explored.data.affectedFiles.length).toBeGreaterThan(0);
      expect(explored.data.suggestedRefactoring.length).toBeGreaterThan(10);
    }

    store.close();
  });

  it('explain_finding returns mentor-style explanation', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const handler = new ExplainFindingHandler(sessions, explanation);
    const result = await handler.execute({ path: project, findingCode: 'PresentationImportsData' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.whyThisMatters!.length).toBeGreaterThan(20);
      expect(result.data.fix!.suggestedRefactor.length).toBeGreaterThan(20);
      expect(result.data.fix!.potentialTradeoffs.length).toBeGreaterThan(0);
      expect(result.data.summary).toBeTruthy();
      // Single evidence array — no more duplication across explanation/recommendation.
      expect(result.data.evidence).toBeDefined();
    }
    store.close();
  });

  it('explore_finding returns evidence drill-down', async () => {
    const project = await createFixtureApp();
    const { store, sessions, recommendations } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ExploreFindingHandler(sessions, recommendations).execute({
      path: project,
      findingCode: 'PresentationImportsData',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.affectedFiles.length).toBeGreaterThan(0);
      expect(result.data.confidence).toBeGreaterThan(0.5);
      expect(result.data.suggestedRefactoring.length).toBeGreaterThan(10);
    }
    store.close();
  });

  it('explain_finding default (no params) has no evidence duplication and matches prior content', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'PresentationImportsData',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const json = JSON.stringify(result.data);
      // There must be exactly one occurrence of the evidence array in the
      // serialized JSON — not the old explanation.evidence /
      // recommendation.evidence / recommendation.evidenceItems triplication.
      expect((json.match(/"evidence":/g) ?? []).length).toBe(1);
      expect('explanation' in result.data).toBe(false);
      expect('recommendation' in result.data).toBe(false);
      // Content equivalent to the old response, just deduplicated + flattened.
      expect(result.data.summary).toBeTruthy();
      expect(result.data.whyThisMatters).toBeTruthy();
      expect(result.data.fix?.suggestedRefactor).toBeTruthy();
      expect(result.data.priority).toBeTruthy();
      expect(result.data.confidence).toBeGreaterThan(0.5);
    }
    store.close();
  });

  it('explain_finding verbosity=brief returns only summary + fix + evidence + priority/confidence', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'PresentationImportsData',
      verbosity: 'brief',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const keys = Object.keys(result.data).sort();
      expect(keys).toEqual(
        [
          'sessionId',
          'fromCache',
          'projectPath',
          'findingCode',
          'summary',
          'fix',
          'evidence',
          'priority',
          'confidence',
          'bytes',
          'approxTokens',
        ].sort(),
      );
      expect(result.data.relatedFindings).toBeUndefined();
      expect(result.data.officialReferences).toBeUndefined();
    }
    store.close();
  });

  it('explain_finding verbosity=full does not suppress official-reference-family fields', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'PresentationImportsData',
      verbosity: 'full',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // officialGuidance is always a non-empty string by design (present or
      // "none resolved" message) — full must not suppress it via includeOfficialRefs.
      expect(result.data.officialGuidance).toBeTruthy();
      // brief explicitly excludes this field; full must include it.
      expect(result.data.technicalExplanation).toBeTruthy();
    }
    store.close();
  });

  it('explain_finding includeRelated toggles relatedFindings, and never leaks an empty array', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const included = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'PresentationImportsData',
      verbosity: 'full',
      includeRelated: true,
    });
    expect(included.success).toBe(true);
    if (included.success) {
      // Global cleanup rule: if there's nothing related, omit the field
      // entirely rather than returning relatedFindings: [].
      if (included.data.relatedFindings !== undefined) {
        expect(included.data.relatedFindings.length).toBeGreaterThan(0);
      }
    }

    // includeRelated=false must always suppress it, whether or not any exist.
    const suppressed = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'PresentationImportsData',
      verbosity: 'full',
      includeRelated: false,
    });
    expect(suppressed.success).toBe(true);
    if (suppressed.success) {
      expect(suppressed.data.relatedFindings).toBeUndefined();
    }
    store.close();
  });

  it('explain_finding fields allowlist overrides verbosity for field selection', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'PresentationImportsData',
      verbosity: 'full',
      fields: ['summary'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const keys = Object.keys(result.data).sort();
      expect(keys).toEqual(
        ['sessionId', 'fromCache', 'projectPath', 'findingCode', 'summary', 'bytes', 'approxTokens'].sort(),
      );
    }
    store.close();
  });

  it('explain_finding includeOfficialRefs=false omits the entire official-reference block', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'PresentationImportsData',
      includeOfficialRefs: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.officialReferences).toBeUndefined();
      expect(result.data.officialGuidance).toBeUndefined();
      expect(result.data.realFlutterExamples).toBeUndefined();
    }
    store.close();
  });

  it('explain_finding maxEvidence truncates real multi-item evidence with an omitted count', async () => {
    const project = await createFixtureAppWithManyLargeBuildMethods(8);
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const defaultResult = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'LargeBuildMethod',
    });
    expect(defaultResult.success).toBe(true);
    if (defaultResult.success) {
      // Default maxEvidence=5, real finding has 8 evidence items.
      expect(defaultResult.data.evidence?.length).toBe(5);
      expect(defaultResult.data.evidenceOmittedCount).toBe(3);
    }

    const cappedResult = await new ExplainFindingHandler(sessions, explanation).execute({
      sessionId: defaultResult.success ? defaultResult.data.sessionId : undefined,
      findingCode: 'LargeBuildMethod',
      maxEvidence: 3,
    });
    expect(cappedResult.success).toBe(true);
    if (cappedResult.success) {
      expect(cappedResult.data.evidence?.length).toBe(3);
      expect(cappedResult.data.evidenceOmittedCount).toBe(5);
    }

    const uncappedResult = await new ExplainFindingHandler(sessions, explanation).execute({
      sessionId: defaultResult.success ? defaultResult.data.sessionId : undefined,
      findingCode: 'LargeBuildMethod',
      maxEvidence: 100,
    });
    expect(uncappedResult.success).toBe(true);
    if (uncappedResult.success) {
      expect(uncappedResult.data.evidence?.length).toBe(8);
      expect(uncappedResult.data.evidenceOmittedCount).toBeUndefined();
    }

    store.close();
  });

  it('explore_finding maxEvidence caps evidence independently of limit (which still caps affectedFiles)', async () => {
    const project = await createFixtureAppWithManyLargeBuildMethods(8);
    const { store, sessions, recommendations } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const result = await new ExploreFindingHandler(sessions, recommendations).execute({
      path: project,
      findingCode: 'LargeBuildMethod',
      maxEvidence: 4,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.evidence?.length).toBe(4);
      expect(result.data.evidenceOmittedCount).toBe(4);
    }
    store.close();
  });

  it('explore_finding verbosity=brief trims the response and omits empty fields', async () => {
    const project = await createFixtureApp();
    const { store, sessions, recommendations } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ExploreFindingHandler(sessions, recommendations).execute({
      path: project,
      findingCode: 'PresentationImportsData',
      verbosity: 'brief',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const keys = Object.keys(result.data).sort();
      expect(keys).toEqual(
        [
          'sessionId',
          'fromCache',
          'projectPath',
          'finding',
          'evidence',
          'suggestedRefactoring',
          'confidence',
          'bytes',
          'approxTokens',
        ].sort(),
      );
      // Global cleanup: no null/empty placeholders for omitted-count or officialReferences.
      expect(result.data.evidenceOmittedCount).toBeUndefined();
      expect(result.data.officialReferences).toBeUndefined();
    }
    store.close();
  });

  it('explain_finding codes[] batch returns one result per code, including a not_found entry for unknown codes', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      codes: ['PresentationImportsData', 'NoSuchFindingCodeXYZ'],
    });
    expect(result.success).toBe(true);
    if (result.success && 'results' in result.data) {
      expect(result.data.results.length).toBe(2);
      const [found, missing] = result.data.results;
      expect(found).toHaveProperty('findingCode', 'PresentationImportsData');
      expect(found).toHaveProperty('summary');
      expect(missing).toEqual({
        findingCode: 'NoSuchFindingCodeXYZ',
        status: 'not_found',
        reason: 'unknown_code',
        message: expect.stringContaining('NoSuchFindingCodeXYZ'),
      });
    } else {
      expect.fail('expected a batch results shape');
    }
    store.close();
  });

  it('explore_finding codes[] batch matches the single-lookup content for the same code', async () => {
    const project = await createFixtureApp();
    const { store, sessions, recommendations } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const single = await new ExploreFindingHandler(sessions, recommendations).execute({
      path: project,
      findingCode: 'PresentationImportsData',
    });
    expect(single.success).toBe(true);

    const batch = await new ExploreFindingHandler(sessions, recommendations).execute({
      sessionId: single.success ? (single.data as { sessionId: string }).sessionId : undefined,
      codes: ['PresentationImportsData'],
    });
    expect(batch.success).toBe(true);
    if (single.success && batch.success && 'results' in batch.data) {
      expect(batch.data.results.length).toBe(1);
      const [item] = batch.data.results;
      expect(item).toHaveProperty('suggestedRefactoring', (single.data as { suggestedRefactoring: string }).suggestedRefactoring);
    } else {
      expect.fail('expected a batch results shape');
    }
    store.close();
  });

  it('fail-fast: analyze_code_quality on a project with zero Dart files returns a blocked status immediately', async () => {
    const project = await createEmptyFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new AnalyzeCodeQualityHandler(sessions).execute({ path: project });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ status: 'blocked', reason: 'no_dart_files' });
      // Short structured response, not partial analyzer output.
      expect('narrative' in result.data).toBe(false);
      expect('findings' in result.data).toBe(false);
    }
    store.close();
  });

  it('fail-fast: review_project on a project with zero Dart files returns a blocked status, not a hollow report', async () => {
    const project = await createEmptyFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({ path: project });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ status: 'blocked', reason: 'no_dart_files' });
      expect('overallHealth' in result.data).toBe(false);
    }
    store.close();
  });

  it('fail-fast: explain_finding/explore_finding for an unknown code fail immediately with reason=unknown_code (not partial work)', async () => {
    const project = await createFixtureApp();
    const { store, sessions, explanation, recommendations } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const explained = await new ExplainFindingHandler(sessions, explanation).execute({
      path: project,
      findingCode: 'TotallyMadeUpCode',
    });
    expect(explained.success).toBe(false);
    if (!explained.success) {
      expect(explained.error.details).toMatchObject({ reason: 'unknown_code' });
    }

    const explored = await new ExploreFindingHandler(sessions, recommendations).execute({
      path: project,
      findingCode: 'TotallyMadeUpCode',
    });
    expect(explored.success).toBe(false);
    if (!explored.success) {
      expect(explored.error.details).toMatchObject({ reason: 'unknown_code' });
    }
    store.close();
  });

  it('review_project topRisks/topActions include sampleFiles pulled from real finding evidence, never fabricated', async () => {
    const project = await createFixtureApp();
    const { store, sessions, reports } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const report = await reports.build(project);

    const allRealEvidenceFiles = new Set<string>();
    for (const f of report.findings) {
      if (f.file) allRealEvidenceFiles.add(f.file);
      for (const item of f.evidenceItems ?? []) {
        if (item.file) allRealEvidenceFiles.add(item.file);
      }
    }

    const result = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({ path: project });
    expect(result.success).toBe(true);
    if (result.success && 'topRisks' in result.data) {
      const risksWithFiles = result.data.topRisks.filter((r) => r.sampleFiles.length > 0);
      const actionsWithFiles = result.data.topActions.filter((a) => a.sampleFiles.length > 0);
      expect(risksWithFiles.length + actionsWithFiles.length).toBeGreaterThan(0);

      for (const risk of risksWithFiles) {
        for (const file of risk.sampleFiles) {
          expect(allRealEvidenceFiles.has(file)).toBe(true);
        }
        expect(risk.sampleFiles.length).toBeLessThanOrEqual(3);
      }
      for (const action of actionsWithFiles) {
        for (const file of action.sampleFiles) {
          expect(allRealEvidenceFiles.has(file)).toBe(true);
        }
      }
    } else {
      expect.fail('expected the summary shape with topRisks');
    }
    store.close();
  });

  it('analyze_architecture pathGlob/feature scoping returns a strict subset of the unfiltered findings', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const unfiltered = await new AnalyzeArchitectureHandler(sessions).execute({ path: project });
    expect(unfiltered.success).toBe(true);

    const sessionId =
      unfiltered.success && 'sessionId' in unfiltered.data ? unfiltered.data.sessionId : undefined;

    const matching = await new AnalyzeArchitectureHandler(sessions).execute({
      sessionId,
      pathGlob: 'lib/features/home/presentation/**',
    });
    const nonMatching = await new AnalyzeArchitectureHandler(sessions).execute({
      sessionId,
      feature: 'totally-nonexistent-feature',
    });

    expect(unfiltered.success && matching.success && nonMatching.success).toBe(true);
    if (
      unfiltered.success &&
      matching.success &&
      nonMatching.success &&
      'findings' in unfiltered.data &&
      'findings' in matching.data &&
      'findings' in nonMatching.data
    ) {
      // A non-matching scope must yield a strict subset (fewer findings) —
      // it's a real filter, not a no-op.
      expect(nonMatching.data.findings.length).toBeLessThan(unfiltered.data.findings.length);
      // A scope that actually matches PresentationImportsData's evidence
      // keeps it, and is not larger than the unfiltered set.
      expect(matching.data.findings.length).toBeLessThanOrEqual(unfiltered.data.findings.length);
      expect(
        matching.data.findings.some((f) => f.code === 'PresentationImportsData'),
      ).toBe(true);
      expect(
        nonMatching.data.findings.some((f) => f.code === 'PresentationImportsData'),
      ).toBe(false);
    } else {
      expect.fail('expected the normal analyze_architecture shape (not blocked)');
    }
    store.close();
  });

  it('analyze_* responses include bytes/approxTokens size metadata', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const result = await new AnalyzeCodeQualityHandler(sessions).execute({ path: project });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bytes).toBeGreaterThan(0);
      expect(result.data.approxTokens).toBeGreaterThan(0);
      expect(result.data.approxTokens).toBe(Math.ceil(result.data.bytes / 4));
    }
    store.close();
  });

  it('find_intended_behavior auto-bootstraps and returns "building" when the index is empty', async () => {
    tempDir = await createTempDir('intended-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'k.sqlite'));

    const startBackgroundUpdate = vi.fn().mockReturnValue([
      { name: 'flutter/flutter', status: 'queued' },
    ]);
    const repositories = {
      getStatus: vi.fn().mockResolvedValue([]),
      listDefinitions: () => [],
      startBackgroundUpdate,
    } as unknown as RepositoryManager;

    const readinessChecker = new KnowledgeBaseReadinessChecker(repositories, store, new SilentLogger());
    const engine = new IntendedBehaviourEngine(store, readinessChecker);
    const handler = new FindIntendedBehaviorHandler(engine);
    const result = await handler.execute({ topic: 'NonexistentWidgetXYZ123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('building');
      expect(result.data.suggestedAction).toMatch(/repository_status/i);
      expect(result.data.summary).toMatch(/being built in the background/i);
      expect(result.data.knowledgeBase?.status).toBe('building');
    }
    // Auto-bootstrap kicked off the same background clone update_repositories uses.
    expect(startBackgroundUpdate).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('find_intended_behavior serves partial results and notes skipped sources when only some repos are indexed', async () => {
    tempDir = await createTempDir('intended-partial-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'k.sqlite'));

    const flutter = store.upsertRepository({
      name: 'flutter/flutter',
      path: '/repos/flutter',
      commitHash: 'a',
    });
    const file = store.upsertFile({
      repositoryId: flutter.id,
      path: 'packages/flutter/lib/src/widgets/container.dart',
      kind: 'dart',
      hash: '1',
      mtimeMs: 1,
    });
    store.replaceSymbolsForFile(file.id, [
      {
        fileId: file.id,
        name: 'Container',
        kind: 'class',
        line: 10,
        isWidget: true,
        isWidgetTest: false,
        docstring: 'A convenience widget.',
        packageName: 'flutter',
      },
    ]);

    // Only flutter/flutter is cloned; the other 5 expected sources are missing.
    const repositories = {
      getStatus: vi.fn().mockResolvedValue([
        {
          name: 'flutter/flutter',
          exists: true,
          path: '/repos/flutter',
          branch: 'main',
          commit: 'abc123',
          lastPull: new Date().toISOString(),
        },
      ]),
      listDefinitions: () => [
        { name: 'flutter/flutter', localName: 'flutter', cloneUrl: '', defaultBranch: 'main' },
        { name: 'flutter/samples', localName: 'samples', cloneUrl: '', defaultBranch: 'main' },
        { name: 'flutter/packages', localName: 'packages', cloneUrl: '', defaultBranch: 'main' },
        { name: 'flutter/website', localName: 'website', cloneUrl: '', defaultBranch: 'main' },
        { name: 'dart-lang/sdk', localName: 'sdk', cloneUrl: '', defaultBranch: 'main' },
        { name: 'dart-lang/site-www', localName: 'site-www', cloneUrl: '', defaultBranch: 'main' },
      ],
      startBackgroundUpdate: vi.fn().mockReturnValue([]),
    } as unknown as RepositoryManager;

    const readinessChecker = new KnowledgeBaseReadinessChecker(repositories, store, new SilentLogger());
    const engine = new IntendedBehaviourEngine(store, readinessChecker);
    const handler = new FindIntendedBehaviorHandler(engine);
    const result = await handler.execute({ topic: 'Container' });
    expect(result.success).toBe(true);
    if (result.success) {
      // Served what's available now rather than waiting for 100% completion.
      expect(result.data.status).toBe('ok');
      expect(result.data.results.length).toBeGreaterThan(0);
      expect(result.data.knowledgeBase?.skippedSources).toEqual(
        expect.arrayContaining(['flutter/samples', 'dart-lang/sdk']),
      );
      expect(result.data.suggestedAction).toMatch(/update_repositories/i);
    }
    expect(repositories.startBackgroundUpdate).not.toHaveBeenCalled();
    store.close();
  });

  it('find_intended_behavior omits knowledgeBase entirely when the index is fully ready (matches the other 8 knowledge-base tools)', async () => {
    // Regression test: find_intended_behavior used to always attach a
    // legacy knowledgeBase stats block (available/reason/expectedSources/
    // indexedRepositoryCount/indexedSymbolCount) that predated the shared
    // KnowledgeBaseReadinessChecker, even when the knowledge base was fully
    // ready — unlike find_widget/search_docs/etc., which correctly omit
    // knowledgeBase in that state. This asserts the now-consolidated
    // contract: knowledgeBase is present only when building/degraded, and
    // absent (undefined) once every expected source is cloned and fresh.
    tempDir = await createTempDir('intended-ready-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'k.sqlite'));

    const flutter = store.upsertRepository({
      name: 'flutter/flutter',
      path: '/repos/flutter',
      commitHash: 'a',
    });
    const file = store.upsertFile({
      repositoryId: flutter.id,
      path: 'packages/flutter/lib/src/widgets/container.dart',
      kind: 'dart',
      hash: '1',
      mtimeMs: 1,
    });
    store.replaceSymbolsForFile(file.id, [
      {
        fileId: file.id,
        name: 'Container',
        kind: 'class',
        line: 10,
        isWidget: true,
        isWidgetTest: false,
        docstring: 'A convenience widget.',
        packageName: 'flutter',
      },
    ]);

    const expectedSources = [
      'flutter/flutter',
      'flutter/samples',
      'flutter/packages',
      'flutter/website',
      'dart-lang/sdk',
      'dart-lang/site-www',
    ];

    // All 6 expected sources exist and are freshly pulled — nothing missing,
    // nothing stale, nothing cloning. This is the "ready" state.
    const repositories = {
      getStatus: vi.fn().mockResolvedValue(
        expectedSources.map((name) => ({
          name,
          exists: true,
          path: `/repos/${name}`,
          branch: 'main',
          commit: 'abc123',
          lastPull: new Date().toISOString(),
        })),
      ),
      listDefinitions: () =>
        expectedSources.map((name) => ({
          name,
          localName: name,
          cloneUrl: '',
          defaultBranch: 'main',
        })),
      startBackgroundUpdate: vi.fn().mockReturnValue([]),
    } as unknown as RepositoryManager;

    const readinessChecker = new KnowledgeBaseReadinessChecker(repositories, store, new SilentLogger());
    const engine = new IntendedBehaviourEngine(store, readinessChecker);
    const handler = new FindIntendedBehaviorHandler(engine);
    const result = await handler.execute({ topic: 'Container' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('ok');
      expect(result.data.results.length).toBeGreaterThan(0);
      // Same contract as find_widget/search_docs/etc: undefined (and so
      // dropped by JSON.stringify over MCP) once the index is fully ready.
      expect(result.data.knowledgeBase).toBeUndefined();
      expect(result.data.suggestedAction).toBeUndefined();
      expect(JSON.stringify(result.data)).not.toContain('knowledgeBase');
    }
    expect(repositories.startBackgroundUpdate).not.toHaveBeenCalled();
    store.close();
  });

  it('analyze_* tools expose slim category scores', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const arch = await new AnalyzeArchitectureHandler(sessions).execute({ path: project });
    expect(arch.success).toBe(true);
    if (arch.success) {
      expect(arch.data.fromCache).toBe(false);
      expect(arch.data.score?.topPositives).toBeDefined();
      expect(arch.data.alternatives).toBeDefined();
      expect(arch.data.detected).toBeTruthy();
    }

    const quality = await new AnalyzeCodeQualityHandler(sessions).execute({ path: project });
    expect(quality.success).toBe(true);

    const state = await new AnalyzeStateManagementHandler(sessions).execute({ path: project });
    expect(state.success).toBe(true);

    store.close();
  });

  it('AstAdapter prefers dart_analyzer when available', async () => {
    tempDir = await createTempDir('ast-prefer-');
    const project = path.join(tempDir, 'app');
    await mkdir(path.join(project, 'lib'), { recursive: true });
    await writeFile(path.join(project, 'pubspec.yaml'), 'name: tiny\n', 'utf8');
    await writeFile(path.join(project, 'lib', 'main.dart'), 'class TinyApp {}\n', 'utf8');

    const dart = {
      isAvailable: async () => true,
      analyzeFiles: async () => ({
        available: true,
        files: [
          {
            path: 'lib/main.dart',
            symbols: [
              {
                name: 'TinyApp',
                kind: 'class',
                line: 1,
                isWidget: false,
                docstring: null,
                packageName: null,
                extendsClause: null,
                withClause: null,
                implementsClause: null,
              },
            ],
          },
        ],
      }),
      getHelperPath: () => '',
      toInsertSymbols: () => [],
    } as unknown as DartAnalyzerClient;

    const extractSpy = vi.spyOn(HeuristicSymbolExtractor.prototype, 'extractDart');
    const ast = new AstAdapter(dart, new HeuristicSymbolExtractor(), new SilentLogger());
    const scanner = new ProjectScanner(ast, new SilentLogger());
    const snapshot = await scanner.scan(project);
    expect(snapshot.astMeta.source).toBe('dart_analyzer');
    expect(extractSpy).not.toHaveBeenCalled();
    extractSpy.mockRestore();
  });

  it('buildAnalysisSummary still works', async () => {
    const project = await createFixtureApp();
    const { store, scanner, codeQuality } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const snapshot = await scanner.scan(project);
    const quality = codeQuality.analyze(snapshot);
    const summary = buildAnalysisSummary(snapshot.astMeta, quality.findings);
    expect(summary.engine).toContain('Flutter Analysis Engine');
    store.close();
  });

  it('ComplexityAnalyzer returns facts and findings for fixture app', async () => {
    const project = await createFixtureApp();
    const { store, scanner, complexity } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const snapshot = await scanner.scan(project);
    const result = complexity.analyze(snapshot);
    expect(result.engine).toBe('complexity');
    expect(typeof result.facts.averageFileLoc).toBe('number');
    expect(typeof result.facts.largeFileCount).toBe('number');
    expect(result.findings.length).toBeGreaterThanOrEqual(0);
    store.close();
  });

  it('TestingAnalyzer detects missing tests', async () => {
    const project = await createFixtureApp();
    const { store, scanner, testing } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const snapshot = await scanner.scan(project);
    const result = testing.analyze(snapshot);
    expect(result.engine).toBe('testing');
    expect(result.facts.testFileCount).toBe(0);
    expect(result.facts.libFileCount).toBeGreaterThan(0);
    const noTest = result.findings.find((f) => f.code === 'NoTestSuite');
    expect(noTest).toBeDefined();
    expect(noTest?.severity).toBe('negative');
    store.close();
  });

  it('DependencyAnalyzer detects layer violations', async () => {
    const project = await createFixtureApp();
    const { store, scanner, dependency } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const snapshot = await scanner.scan(project);
    const result = dependency.analyze(snapshot);
    expect(result.engine).toBe('dependency');
    expect(typeof result.facts.totalEdges).toBe('number');
    expect(Array.isArray(result.facts.layerViolations)).toBe(true);
    // fixture has a presentation file importing data layer
    const layerFinding = result.findings.find((f) => f.code === 'LayerViolations');
    expect(layerFinding).toBeDefined();
    store.close();
  });

  it('PerformanceAnalyzer returns a performance score', async () => {
    const project = await createFixtureApp();
    const { store, scanner, performance } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const snapshot = await scanner.scan(project);
    const result = performance.analyze(snapshot);
    expect(result.engine).toBe('performance');
    expect(result.facts.performanceScore).toBeGreaterThan(0);
    expect(result.facts.performanceScore).toBeLessThanOrEqual(100);
    store.close();
  });

  it('DocumentationAnalyzer detects missing analysis_options', async () => {
    const project = await createFixtureApp();
    const { store, scanner, documentation } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const snapshot = await scanner.scan(project);
    const result = documentation.analyze(snapshot);
    expect(result.engine).toBe('documentation');
    expect(typeof result.facts.documentationScore).toBe('number');
    // fixture has analysis_options.yaml
    expect(result.facts.hasAnalysisOptions).toBe(true);
    const optionsFinding = result.findings.find((f) => f.code === 'HasAnalysisOptions');
    expect(optionsFinding?.severity).toBe('positive');
    store.close();
  });

  it('AccessibilityAnalyzer scans lib files for semantic annotations', async () => {
    const project = await createFixtureApp();
    const { store, scanner, accessibility } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const snapshot = await scanner.scan(project);
    const result = accessibility.analyze(snapshot);
    expect(result.engine).toBe('accessibility');
    expect(typeof result.facts.accessibilityScore).toBe('number');
    expect(result.facts.libFilesScanned).toBeGreaterThan(0);
    store.close();
  });

  it('analyze_complexity returns cache hit with detected summary and facts', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (!review.success || !('sessionId' in review.data)) { store.close(); return; }
    const sessionId = review.data.sessionId;

    const result = await new AnalyzeComplexityHandler(sessions).execute({ sessionId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fromCache).toBe(true);
      expect(typeof result.data.detected).toBe('string');
      expect(result.data.detected).toMatch(/avg file/);
      expect(Array.isArray(result.data.findings)).toBe(true);
    }
    store.close();
  });

  it('analyze_documentation returns cache hit with doc ratios', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (!review.success || !('sessionId' in review.data)) { store.close(); return; }
    const sessionId = review.data.sessionId;

    const result = await new AnalyzeDocumentationHandler(sessions).execute({ sessionId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fromCache).toBe(true);
      expect(typeof result.data.widgetDocumentationRatio).toBe('number');
      expect(typeof result.data.classDocumentationRatio).toBe('number');
    }
    store.close();
  });

  it('analyze_testing returns cache hit with test counts', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (!review.success || !('sessionId' in review.data)) { store.close(); return; }
    const sessionId = review.data.sessionId;

    const result = await new AnalyzeTestingHandler(sessions).execute({ sessionId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fromCache).toBe(true);
      expect(typeof result.data.testFileCount).toBe('number');
      expect(typeof result.data.testToLibRatio).toBe('number');
    }
    store.close();
  });

  it('analyze_dependencies returns cache hit with layer violation count', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (!review.success || !('sessionId' in review.data)) { store.close(); return; }
    const sessionId = review.data.sessionId;

    const result = await new AnalyzeDependenciesHandler(sessions).execute({ sessionId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fromCache).toBe(true);
      expect(typeof result.data.totalEdges).toBe('number');
      expect(typeof result.data.layerViolationCount).toBe('number');
    }
    store.close();
  });

  it('analyze_performance returns cache hit with build method count', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (!review.success || !('sessionId' in review.data)) { store.close(); return; }
    const sessionId = review.data.sessionId;

    const result = await new AnalyzePerformanceHandler(sessions).execute({ sessionId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fromCache).toBe(true);
      expect(typeof result.data.largeBuildMethodCount).toBe('number');
      expect(typeof result.data.constOpportunityCount).toBe('number');
    }
    store.close();
  });

  it('analyze_accessibility returns cache hit with semantics counts', async () => {
    const project = await createFixtureApp();
    const { store, sessions } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const review = await new ReviewProjectHandler(sessions, new SilentLogger()).execute({
      path: project,
    });
    expect(review.success).toBe(true);
    if (!review.success || !('sessionId' in review.data)) { store.close(); return; }
    const sessionId = review.data.sessionId;

    const result = await new AnalyzeAccessibilityHandler(sessions).execute({ sessionId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fromCache).toBe(true);
      expect(typeof result.data.semanticsWidgetCount).toBe('number');
      expect(typeof result.data.libFilesScanned).toBe('number');
    }
    store.close();
  });

  it('review_project includes results from all 9 analyzers', async () => {
    const project = await createFixtureApp();
    const { store, reports } = buildStack(path.join(tempDir!, 'k.sqlite'));
    const report = await reports.build(project);
    expect(report.results.complexity).toBeDefined();
    expect(report.results.testing).toBeDefined();
    expect(report.results.dependency).toBeDefined();
    expect(report.results.performance).toBeDefined();
    expect(report.results.documentation).toBeDefined();
    expect(report.results.accessibility).toBeDefined();
    // health scores should now come from real analyzers
    const perfScore = report.health.scores.find((s) => s.id === 'performance');
    expect(perfScore).toBeDefined();
    expect(perfScore!.confidence).toBeGreaterThan(0.6);
    const accessScore = report.health.scores.find((s) => s.id === 'accessibility');
    expect(accessScore).toBeDefined();
    expect(accessScore!.confidence).toBeGreaterThan(0.6);
    store.close();
  });
});

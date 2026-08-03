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
    const scanner = new ProjectScanner(ast);
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
      expect(explained.data.explanation.whyThisMatters.length).toBeGreaterThan(20);
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
      expect(result.data.explanation.whyThisMatters.length).toBeGreaterThan(20);
      expect(result.data.explanation.suggestedArchitecture.length).toBeGreaterThan(20);
      expect(result.data.explanation.potentialTradeoffs.length).toBeGreaterThan(0);
      expect(result.data.recommendation.problem).toBeTruthy();
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

  it('find_intended_behavior cascades all sources before empty', async () => {
    tempDir = await createTempDir('intended-');
    const store = createSqliteKnowledgeStore(path.join(tempDir, 'k.sqlite'));
    const engine = new IntendedBehaviourEngine(store);
    const handler = new FindIntendedBehaviorHandler(engine);
    const result = await handler.execute({ topic: 'NonexistentWidgetXYZ123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exhaustedAllSources).toBe(true);
      expect(result.data.searchedSteps.length).toBeGreaterThanOrEqual(7);
      expect(result.data.status).toBe('blocked');
      expect(result.data.knowledgeBase?.available).toBe(false);
      expect(result.data.knowledgeBase?.nextStep).toMatch(/update_repositories/i);
      expect(result.data.summary).toMatch(/Knowledge base unavailable|not indexed/i);
    }
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
    const scanner = new ProjectScanner(ast);
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

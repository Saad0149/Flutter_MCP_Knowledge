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
import { AnalysisSessionStore } from '../../../src/analysis/session/analysis-session-store.js';
import { ScoringEngine } from '../../../src/analysis/scoring/scoring-engine.js';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { HeuristicSymbolExtractor } from '../../../src/parser/heuristic-extractor.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import { ExplainFindingHandler } from '../../../src/tools/explain-finding.js';
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

const ALL_9_ANALYZERS = [
  'architecture',
  'codeQuality',
  'stateManagement',
  'complexity',
  'testing',
  'dependency',
  'performance',
  'documentation',
  'accessibility',
];

describe('review_project explainTopFindings', () => {
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
    const explainFinding = new ExplainFindingHandler(sessions, explanation);
    const reviewProject = new ReviewProjectHandler(sessions, logger, explainFinding);
    return { store, reports, sessions, explainFinding, reviewProject, scanner };
  }

  /**
   * Dense fixture with at least one negative/warning finding in ALL 9
   * analyzer categories, several with real file evidence (GodClassCandidate,
   * LargeBuildMethod, PresentationImportsData, LayerViolations,
   * DomainImportsData) and several confirmed evidence-less by the earlier
   * hasLocatableEvidence work (HeavySetState, HugeWidgets, NoSemanticsWidgets,
   * NoTestSuite) — so the response exercises both the "real evidence" and
   * "honestly empty" cases for point 4.
   */
  async function createFixtureApp(): Promise<string> {
    tempDir = await createTempDir('explain-top-findings-');
    const project = path.join(tempDir, 'app');
    await mkdir(path.join(project, 'lib', 'core'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'home', 'presentation'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'home', 'data'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'features', 'home', 'domain'), { recursive: true });
    await mkdir(path.join(project, 'lib', 'widgets'), { recursive: true });

    await writeFile(
      path.join(project, 'pubspec.yaml'),
      `name: explain_top_app\nversion: 1.0.0\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n`,
      'utf8',
    );

    // Circular import (dependency).
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

    // God class (codeQuality): >=400 LOC, 25 methods, 20 fields, 20 imports.
    const methodLines = Array.from({ length: 25 }, (_, i) => `  void method${i}() {}`).join('\n');
    const fieldLines = Array.from({ length: 20 }, (_, i) => `  final int field${i} = ${i};`).join('\n');
    const padLines = Array.from({ length: 350 }, () => '  ;').join('\n');
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

    // Large build method + Presentation->Data import (architecture + dependency)
    // + undocumented widget (documentation) + print()/legacy-button-free but
    // large enough build.
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
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'domain', 'home_usecase.dart'),
      "import '../data/home_repository.dart';\n\nclass HomeUsecase { final repo = HomeRepository(); }\n",
      'utf8',
    );

    // Heavy/problematic setState (stateManagement) — evidence-less by design.
    const setStateCalls = Array.from({ length: 41 }, () => '    setState(() {});').join('\n');
    await writeFile(
      path.join(project, 'lib', 'features', 'home', 'presentation', 'heavy_state.dart'),
      `import 'package:flutter/material.dart';\nimport 'package:http/http.dart' as http;\n\nclass HeavyStatePage extends StatefulWidget {\n  const HeavyStatePage({super.key});\n  @override\n  State<HeavyStatePage> createState() => _HeavyStatePageState();\n}\n\nclass _HeavyStatePageState extends State<HeavyStatePage> {\n  Future<void> load() async {\n    await http.get(Uri.parse('https://example.com'));\n${setStateCalls}\n  }\n\n  @override\n  Widget build(BuildContext context) => Container();\n}\n`,
      'utf8',
    );

    // Huge widget (complexity) — evidence-less by design.
    const hugePad = Array.from({ length: 615 }, () => '// pad').join('\n');
    await writeFile(
      path.join(project, 'lib', 'widgets', 'huge_widget.dart'),
      `import 'package:flutter/material.dart';\n\nclass HugeWidget extends StatelessWidget {\n  const HugeWidget({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return Container();\n  }\n}\n${hugePad}\n`,
      'utf8',
    );

    // Deliberately: no test/ directory (testing: NoTestSuite, evidence-less),
    // no Semantics/Tooltip usage (accessibility: NoSemanticsWidgets, evidence-less),
    // no analysis_options.yaml (documentation).
    return project;
  }

  it('default output (explainTopFindings omitted) has no topFindingsByAnalyzer field at all', async () => {
    const project = await createFixtureApp();
    const { store, reviewProject } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const result = await reviewProject.execute({ path: project });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('topFindingsByAnalyzer' in result.data).toBe(false);
    }
    store.close();
  });

  it('explainTopFindings:false produces the exact same field set as omitting it', async () => {
    const project = await createFixtureApp();
    const { store, reviewProject } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const omitted = await reviewProject.execute({ path: project });
    const explicit = await reviewProject.execute({ path: project, explainTopFindings: false });
    expect(omitted.success && explicit.success).toBe(true);
    if (omitted.success && explicit.success) {
      // Each call is a fresh rescan (forceRefresh:true), so array-ordering
      // details (e.g. sampleFiles from filesystem read order) can legitimately
      // differ between the two independent scans — the actual regression
      // surface for "byte-for-byte unchanged by default" is the field set,
      // not incidental ordering from an unrelated rescan.
      expect(Object.keys(explicit.data).sort()).toEqual(Object.keys(omitted.data).sort());
      expect('topFindingsByAnalyzer' in explicit.data).toBe(false);
      expect('topFindingsByAnalyzer' in omitted.data).toBe(false);
    }
    store.close();
  });

  it('explainTopFindings:true attaches exactly 9 entries, one per analyzer, in brief-mode shape', async () => {
    const project = await createFixtureApp();
    const { store, reviewProject } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const result = await reviewProject.execute({ path: project, explainTopFindings: true });
    expect(result.success).toBe(true);
    if (!result.success || !('topFindingsByAnalyzer' in result.data)) {
      store.close();
      throw new Error('expected topFindingsByAnalyzer on the summary response');
    }

    const entries = result.data.topFindingsByAnalyzer;
    expect(entries.length).toBe(9);
    expect(entries.map((e) => e.analyzer).sort()).toEqual([...ALL_9_ANALYZERS].sort());

    const withExplanation = entries.filter((e) => e.topFindingExplained !== undefined);
    // This fixture triggers a negative/warning finding in every one of the 9
    // categories, so every entry should have something explained.
    expect(withExplanation.length).toBe(9);

    for (const entry of withExplanation) {
      const explained = entry.topFindingExplained!;
      // Brief-mode shape: summary + fix + priority + confidence present;
      // narrative/official-reference fields brief mode already excludes.
      expect(explained.summary).toBeTruthy();
      expect(explained.fix).toBeDefined();
      expect(explained.priority).toBeDefined();
      expect(explained.confidence).toBeGreaterThan(0);
      expect('officialReferences' in explained).toBe(false);
      expect('officialGuidance' in explained).toBe(false);
      expect('whyThisMatters' in explained).toBe(false);
      expect('technicalExplanation' in explained).toBe(false);
      expect('relatedFindings' in explained).toBe(false);
      expect('relatedFlutterWidgets' in explained).toBe(false);
      expect('relatedApis' in explained).toBe(false);
      // maxEvidence:3 was requested for this reuse path.
      if (explained.evidence) {
        expect(explained.evidence.length).toBeLessThanOrEqual(3);
      }
    }

    store.close();
  });

  it('does not rescan or re-run analyzers: scanner.scan is called exactly once, and a follow-up explain_finding on the same session is a cache hit', async () => {
    const project = await createFixtureApp();
    const { store, reviewProject, explainFinding, scanner } = buildStack(
      path.join(tempDir!, 'k.sqlite'),
    );
    const scanSpy = vi.spyOn(scanner, 'scan');

    const result = await reviewProject.execute({ path: project, explainTopFindings: true });
    expect(result.success).toBe(true);
    expect(scanSpy).toHaveBeenCalledTimes(1);

    if (result.success && 'sessionId' in result.data) {
      const follow = await explainFinding.execute({
        sessionId: result.data.sessionId,
        findingCode: 'GodClassCandidate',
      });
      expect(follow.success).toBe(true);
      if (follow.success && 'fromCache' in follow.data) {
        expect(follow.data.fromCache).toBe(true);
      }
    }
    // Still exactly one scan after the follow-up sessionId-based call.
    expect(scanSpy).toHaveBeenCalledTimes(1);

    store.close();
  });

  it('an analyzer whose top finding has no locatable evidence is handled honestly, not suppressed or faked', async () => {
    const project = await createFixtureApp();
    const { store, reviewProject } = buildStack(path.join(tempDir!, 'k.sqlite'));

    const result = await reviewProject.execute({ path: project, explainTopFindings: true });
    expect(result.success).toBe(true);
    if (!result.success || !('topFindingsByAnalyzer' in result.data)) {
      store.close();
      throw new Error('expected topFindingsByAnalyzer on the summary response');
    }

    const stateManagementEntry = result.data.topFindingsByAnalyzer.find(
      (e) => e.analyzer === 'stateManagement',
    );
    expect(stateManagementEntry, 'stateManagement entry must be present').toBeDefined();
    // Both HeavySetState and LogicInWidgets are confirmed evidence-less state-
    // management findings (pure aggregate counts, no per-instance location) —
    // this fixture's negative-severity LogicInWidgets outranks the warning-
    // severity HeavySetState in the same ranking review_project's own
    // topRisks uses, so either is a valid "no locatable evidence" example.
    expect(['HeavySetState', 'LogicInWidgets']).toContain(stateManagementEntry!.topFindingCode);
    expect(stateManagementEntry!.hasLocatableEvidence).toBe(false);
    // Honest, not suppressed: summary/fix are still there.
    expect(stateManagementEntry!.topFindingExplained).toBeDefined();
    expect(stateManagementEntry!.topFindingExplained!.summary).toBeTruthy();
    expect(stateManagementEntry!.topFindingExplained!.fix).toBeDefined();
    // Not faked: whatever evidence items exist genuinely name no file — this
    // is the same "evidence exists but isn't file-shaped" case hasEvidence
    // vs. hasLocatableEvidence distinguishes; no path is fabricated to fill
    // the gap.
    const evidenceItems = stateManagementEntry!.topFindingExplained!.evidence ?? [];
    expect(evidenceItems.every((item) => item.file === null)).toBe(true);

    store.close();
  });
});

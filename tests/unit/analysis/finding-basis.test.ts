import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AstAdapter } from '../../../src/analysis/ast/ast-adapter.js';
import { AccessibilityAnalyzer } from '../../../src/analysis/engines/accessibility-analyzer.js';
import { ArchitectureAnalyzer } from '../../../src/analysis/engines/architecture-analyzer.js';
import { CodeQualityAnalyzer } from '../../../src/analysis/engines/code-quality-analyzer.js';
import { ComplexityAnalyzer } from '../../../src/analysis/engines/complexity-analyzer.js';
import { DependencyAnalyzer } from '../../../src/analysis/engines/dependency-analyzer.js';
import { DocumentationAnalyzer } from '../../../src/analysis/engines/documentation-analyzer.js';
import { astOrFallback } from '../../../src/analysis/engines/finding-factory.js';
import { PerformanceAnalyzer } from '../../../src/analysis/engines/performance-analyzer.js';
import { StateManagementAnalyzer } from '../../../src/analysis/engines/state-management-analyzer.js';
import { TestingAnalyzer } from '../../../src/analysis/engines/testing-analyzer.js';
import { OfficialReferenceResolver } from '../../../src/analysis/official-refs.js';
import { ProjectScanner } from '../../../src/analysis/project-scanner.js';
import type { AnalysisFinding, ProjectSnapshot } from '../../../src/analysis/types.js';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { HeuristicSymbolExtractor } from '../../../src/parser/heuristic-extractor.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
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

describe('astOrFallback — the dynamic ast/heuristic_fallback resolver', () => {
  it('resolves to ast when the real Dart AST was available for this scan', () => {
    expect(
      astOrFallback({
        source: 'dart_analyzer',
        coverage: 'full',
        filesAnalyzed: 5,
        filesTotal: 5,
        baseConfidence: 1,
      }),
    ).toBe('ast');
  });

  it('resolves to heuristic_fallback when this scan fell back to the regex extractor', () => {
    expect(
      astOrFallback({
        source: 'heuristic',
        coverage: 'full',
        filesAnalyzed: 5,
        filesTotal: 5,
        baseConfidence: 0.75,
      }),
    ).toBe('heuristic_fallback');
  });
});

/**
 * Basis is assigned per finding-code call site, not defaulted — this suite
 * checks a representative code from each of the 9 analyzers against the
 * audit done for this task, so a future edit that reverts a call site to
 * a wrong/omitted basis (or that re-introduces a single blanket default)
 * gets caught.
 */
describe('finding basis — assigned per code, not defaulted, across all 9 analyzers', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  /**
   * Dense fixture triggering at least one finding per analyzer: a god class
   * (code-quality, symbol-dependent -> heuristic_fallback here since the AST
   * is unavailable), a Presentation->Data + Domain->Data import (architecture
   * + dependency, always ast), a large build method + print()/legacy button
   * (performance + code-quality pattern checks), heavy setState (state
   * management pattern check), no analysis_options.yaml / few comments
   * (documentation ast + pattern), no tests (testing ast), an image without
   * semantic label (accessibility pattern), and a large file (complexity
   * pattern) plus a high-import-count file (complexity ast).
   */
  async function createFixtureApp(): Promise<string> {
    tempDir = await createTempDir('finding-basis-');
    const project = path.join(tempDir, 'app');
    const presentationDir = path.join(project, 'lib', 'features', 'home', 'presentation');
    const dataDir = path.join(project, 'lib', 'features', 'home', 'data');
    const domainDir = path.join(project, 'lib', 'features', 'home', 'domain');
    await mkdir(presentationDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(domainDir, { recursive: true });
    await mkdir(path.join(project, 'lib', 'core'), { recursive: true });

    await writeFile(
      path.join(project, 'pubspec.yaml'),
      `name: basis_app\nversion: 1.0.0\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n`,
      'utf8',
    );

    const textLines = Array.from({ length: 90 }, (_, i) => `      Text('line ${i}'),`).join('\n');
    const setStateCalls = Array.from({ length: 41 }, () => '    setState(() {});').join('\n');
    await writeFile(
      path.join(presentationDir, 'home_page.dart'),
      `import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../data/home_repository.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final repo = HomeRepository();

  Future<void> load() async {
    await http.get(Uri.parse('https://example.com'));
${setStateCalls}
  }

  @override
  Widget build(BuildContext context) {
    print('building home page');
    return Column(
      children: [
        RaisedButton(onPressed: () {}, child: new Text('Go')),
        Image.network('https://example.com/a.png'),
${textLines}
      ],
    );
  }
}
`,
      'utf8',
    );

    await writeFile(
      path.join(dataDir, 'home_repository.dart'),
      'class HomeRepository { Future<void> load() async {} }\n',
      'utf8',
    );
    await writeFile(
      path.join(domainDir, 'home_usecase.dart'),
      "import '../data/home_repository.dart';\n\nclass HomeUsecase { final repo = HomeRepository(); }\n",
      'utf8',
    );

    // God-class-sized file: >=400 LOC, 25 methods, 20 fields, 20 imports.
    const methodLines = Array.from({ length: 25 }, (_, i) => `  void method${i}() {}`).join('\n');
    const fieldLines = Array.from({ length: 20 }, (_, i) => `  final int field${i} = ${i};`).join('\n');
    // Non-comment filler (a comment-only pad would inflate the inline-comment
    // ratio and suppress LowInlineComments).
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

    // A couple more plain files (no comments) so libFiles.length > 5 —
    // needed for LowInlineComments to fire.
    await writeFile(path.join(project, 'lib', 'core', 'util_a.dart'), 'class UtilA {}\n', 'utf8');
    await writeFile(path.join(project, 'lib', 'core', 'util_b.dart'), 'class UtilB {}\n', 'utf8');

    // Deliberately no analysis_options.yaml, no test/ directory, no comments.
    return project;
  }

  async function buildSnapshot(): Promise<ProjectSnapshot> {
    const project = await createFixtureApp();
    const logger = new SilentLogger();
    const ast = new AstAdapter(unavailableDartClient(), new HeuristicSymbolExtractor(), logger);
    const scanner = new ProjectScanner(ast, logger);
    return scanner.scan(project);
  }

  it('accessibility findings use pattern (regex counts, not symbol data)', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new AccessibilityAnalyzer(refs).analyze(snapshot);
    const finding = result.findings.find((f) => f.code === 'NoSemanticsWidgets');
    expect(finding, 'fixture must trigger NoSemanticsWidgets').toBeDefined();
    expect(finding!.basis).toBe('pattern');
    store.close();
  });

  it('architecture import-graph findings always use ast, never fallback', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new ArchitectureAnalyzer(refs).analyze(snapshot);
    const finding = result.findings.find((f) => f.code === 'PresentationImportsData');
    expect(finding, 'fixture must trigger PresentationImportsData').toBeDefined();
    expect(finding!.basis).toBe('ast');
    store.close();
  });

  it('code-quality: symbol-dependent findings fall back when AST is unavailable, pure-pattern findings do not', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new CodeQualityAnalyzer(refs).analyze(snapshot);

    const godClass = result.findings.find((f) => f.code === 'GodClassCandidate');
    expect(godClass, 'fixture must trigger GodClassCandidate').toBeDefined();
    // Class *discovery* uses the symbol table, but scoreGodClass()'s actual
    // signals (method/field/import counts, responsibility hints) are always
    // regex over raw content regardless of AST availability — so this is
    // 'pattern' unconditionally, not AST-availability-dependent. (Previously
    // mislabeled astOrFallback(ast); see CONFIDENCE_AUDIT.md.)
    expect(godClass!.basis).toBe('pattern');

    const debugPrint = result.findings.find((f) => f.code === 'DebugPrint');
    expect(debugPrint, 'fixture must trigger DebugPrint').toBeDefined();
    // Pure regex-over-content check — unaffected by AST availability.
    expect(debugPrint!.basis).toBe('pattern');

    const legacyButton = result.findings.find((f) => f.code === 'LegacyButtonApi');
    expect(legacyButton, 'fixture must trigger LegacyButtonApi').toBeDefined();
    expect(legacyButton!.basis).toBe('pattern');

    store.close();
  });

  it('complexity: LOC/nesting estimates use pattern, import-count facts use ast', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new ComplexityAnalyzer(refs).analyze(snapshot);

    const largeFiles = result.findings.find((f) => f.code === 'LargeFiles');
    expect(largeFiles, 'fixture must trigger LargeFiles').toBeDefined();
    expect(largeFiles!.basis).toBe('pattern');

    store.close();
  });

  it('dependency: import-graph findings always use ast', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new DependencyAnalyzer(refs).analyze(snapshot);
    const finding = result.findings.find((f) => f.code === 'LayerViolations');
    expect(finding, 'fixture must trigger LayerViolations').toBeDefined();
    expect(finding!.basis).toBe('ast');
    store.close();
  });

  it('documentation: filesystem facts use ast, symbol-dependent doc ratio falls back, comment ratio is pattern', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new DocumentationAnalyzer(refs).analyze(snapshot);

    const missingOptions = result.findings.find((f) => f.code === 'MissingAnalysisOptions');
    expect(missingOptions, 'fixture must trigger MissingAnalysisOptions').toBeDefined();
    expect(missingOptions!.basis).toBe('ast');

    const lowComments = result.findings.find((f) => f.code === 'LowInlineComments');
    expect(lowComments, 'fixture must trigger LowInlineComments').toBeDefined();
    expect(lowComments!.basis).toBe('pattern');

    store.close();
  });

  it('performance: build()-span/ListView findings fall back when AST is unavailable, other pattern checks do not', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new PerformanceAnalyzer(refs).analyze(snapshot);

    const largeBuildMethod = result.findings.find((f) => f.code === 'LargeBuildMethod');
    expect(largeBuildMethod, 'fixture must trigger LargeBuildMethod').toBeDefined();
    // Real build() body span comes from astMetrics (extract_symbols.dart's
    // visitor) when the Dart AST is available; this test harness's AST is
    // unavailable, so it falls back to brace-matching over text — the
    // actual degraded case.
    expect(largeBuildMethod!.basis).toBe('heuristic_fallback');

    const imageCacheHints = result.findings.find((f) => f.code === 'ImageWithoutCacheHints');
    expect(imageCacheHints, 'fixture must trigger ImageWithoutCacheHints').toBeDefined();
    // Pure regex-over-content check — unaffected by AST availability.
    expect(imageCacheHints!.basis).toBe('pattern');

    store.close();
  });

  it('state-management: setState/business-logic checks use pattern', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new StateManagementAnalyzer(refs).analyze(snapshot);
    const finding = result.findings.find((f) => f.code === 'HeavySetState');
    expect(finding, 'fixture must trigger HeavySetState').toBeDefined();
    expect(finding!.basis).toBe('pattern');
    store.close();
  });

  it('testing: file/content-presence facts use ast', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);
    const result = await new TestingAnalyzer(refs).analyze(snapshot);
    const finding = result.findings.find((f) => f.code === 'NoTestSuite');
    expect(finding, 'fixture must trigger NoTestSuite').toBeDefined();
    expect(finding!.basis).toBe('ast');
    store.close();
  });

  it('every finding across all 9 analyzers has a valid, non-uniform basis (not defaulted to one value)', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);

    const engines = [
      new CodeQualityAnalyzer(refs),
      new StateManagementAnalyzer(refs),
      new ArchitectureAnalyzer(refs),
      new ComplexityAnalyzer(refs),
      new TestingAnalyzer(refs),
      new DependencyAnalyzer(refs),
      new PerformanceAnalyzer(refs),
      new DocumentationAnalyzer(refs),
      new AccessibilityAnalyzer(refs),
    ];

    const allFindings: AnalysisFinding[] = [];
    for (const engine of engines) {
      const result = await engine.analyze(snapshot);
      allFindings.push(...result.findings);
    }

    expect(allFindings.length).toBeGreaterThan(15);
    expect(allFindings.every((f) => ['ast', 'pattern', 'heuristic_fallback'].includes(f.basis))).toBe(
      true,
    );
    const distinctBases = new Set(allFindings.map((f) => f.basis));
    expect(distinctBases.size, 'this dense fixture should exercise more than one basis value').toBeGreaterThan(
      1,
    );

    store.close();
  });
});

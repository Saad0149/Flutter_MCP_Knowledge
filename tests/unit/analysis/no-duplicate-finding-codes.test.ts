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
import { PerformanceAnalyzer } from '../../../src/analysis/engines/performance-analyzer.js';
import { StateManagementAnalyzer } from '../../../src/analysis/engines/state-management-analyzer.js';
import { TestingAnalyzer } from '../../../src/analysis/engines/testing-analyzer.js';
import { OfficialReferenceResolver } from '../../../src/analysis/official-refs.js';
import { ProjectScanner } from '../../../src/analysis/project-scanner.js';
import type { AnalysisFinding, ProjectAnalysisEngine, ProjectSnapshot } from '../../../src/analysis/types.js';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { HeuristicSymbolExtractor } from '../../../src/parser/heuristic-extractor.js';
import { createSqliteKnowledgeStore } from '../../../src/store/sqlite-store.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';
import { findDuplicateFindingCodes } from '../../helpers/assert-no-duplicate-finding-codes.js';

function unavailableDartClient(): DartAnalyzerClient {
  return {
    isAvailable: async () => false,
    analyzeFiles: async () => ({ available: false, files: [], warning: 'unavailable' }),
    getHelperPath: () => '',
    toInsertSymbols: () => [],
  } as unknown as DartAnalyzerClient;
}

/**
 * Deliberately dense fixture: triggers findings from every analyzer at once
 * (large build methods, print(), legacy buttons, missing const, a
 * god-class-sized class, a presentation→data layer violation, a circular
 * import, missing docs, no analysis_options.yaml, no test/ dir, heavy
 * setState, missing dispose, images without semantics) — maximizing the
 * chance that any future accidental code collision (within one analyzer or
 * across two) shows up here rather than only in a narrow fixture.
 */
async function createDenseFixtureApp(tempDir: string): Promise<string> {
  const project = path.join(tempDir, 'app');
  const presentationDir = path.join(project, 'lib', 'features', 'home', 'presentation');
  const dataDir = path.join(project, 'lib', 'features', 'home', 'data');
  await mkdir(presentationDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  await writeFile(
    path.join(project, 'pubspec.yaml'),
    `name: dense_app
version: 1.0.0
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
`,
    'utf8',
  );

  // Large build method + print() + legacy button + missing const + no docs
  // + presentation-imports-data (architecture layer violation).
  const textLines = Array.from({ length: 90 }, (_, i) => `      Text('line ${i}'),`).join('\n');
  await writeFile(
    path.join(presentationDir, 'home_page.dart'),
    `import 'package:flutter/material.dart';
import '../data/home_repository.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final repo = HomeRepository();
  int counter = 0;

  void bump() {
    setState(() {
      counter++;
    });
  }

  @override
  Widget build(BuildContext context) {
    print('building home page');
    return Column(
      children: [
        RaisedButton(onPressed: bump, child: new Text('Go')),
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

  // Circular import between two files.
  await mkdir(path.join(project, 'lib', 'core'), { recursive: true });
  await writeFile(
    path.join(project, 'lib', 'core', 'circular_a.dart'),
    "import 'circular_b.dart';\n\nclass CircularA { CircularB? b; }\n",
    'utf8',
  );
  await writeFile(
    path.join(project, 'lib', 'core', 'circular_b.dart'),
    "import 'circular_a.dart';\n\nclass CircularB { CircularA? a; }\n",
    'utf8',
  );

  // God-class-sized file: >=400 LOC, many methods/fields/imports.
  const methodLines = Array.from({ length: 25 }, (_, i) => `  void method${i}() {}`).join('\n');
  const fieldLines = Array.from({ length: 20 }, (_, i) => `  final int field${i} = ${i};`).join('\n');
  const padLines = Array.from({ length: 350 }, () => '  // pad').join('\n');
  await writeFile(
    path.join(project, 'lib', 'core', 'big_service.dart'),
    `class BigService {\n${methodLines}\n${fieldLines}\n${padLines}\n}\n`,
    'utf8',
  );

  // Image without semantic label / cache hints (accessibility + performance signals).
  await writeFile(
    path.join(project, 'lib', 'core', 'gallery.dart'),
    `import 'package:flutter/material.dart';

class Gallery extends StatelessWidget {
  const Gallery({super.key});
  @override
  Widget build(BuildContext context) {
    return Image.network('https://example.com/a.png');
  }
}
`,
    'utf8',
  );

  // Deliberately no analysis_options.yaml, no test/ directory.
  return project;
}

interface EngineUnderTest {
  readonly label: string;
  readonly engine: ProjectAnalysisEngine;
}

describe('no analyzer emits a duplicate finding code (regression for DUPLICATE_FINDINGS_AUDIT.md)', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  async function buildSnapshot(): Promise<ProjectSnapshot> {
    tempDir = await createTempDir('no-dup-codes-');
    const project = await createDenseFixtureApp(tempDir);
    const logger = new SilentLogger();
    const ast = new AstAdapter(unavailableDartClient(), new HeuristicSymbolExtractor(), logger);
    const scanner = new ProjectScanner(ast, logger);
    return scanner.scan(project);
  }

  it('across ALL 9 analyzers merged together (the actual bug: two different analyzers, same code)', async () => {
    const snapshot = await buildSnapshot();
    const storePath = path.join(tempDir!, 'k.sqlite');
    const store = createSqliteKnowledgeStore(storePath);
    const refs = new OfficialReferenceResolver(store);

    const engines: ProjectAnalysisEngine[] = [
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

    // Sanity: this fixture is dense enough to be a meaningful check, not an
    // accidentally-empty one.
    expect(allFindings.length).toBeGreaterThan(15);

    const duplicates = findDuplicateFindingCodes(allFindings);
    expect(duplicates).toEqual([]);

    store.close();
  });

  it.each([
    ['CodeQualityAnalyzer', (refs: OfficialReferenceResolver) => new CodeQualityAnalyzer(refs)],
    ['StateManagementAnalyzer', (refs: OfficialReferenceResolver) => new StateManagementAnalyzer(refs)],
    ['ArchitectureAnalyzer', (refs: OfficialReferenceResolver) => new ArchitectureAnalyzer(refs)],
    ['ComplexityAnalyzer', (refs: OfficialReferenceResolver) => new ComplexityAnalyzer(refs)],
    ['TestingAnalyzer', (refs: OfficialReferenceResolver) => new TestingAnalyzer(refs)],
    ['DependencyAnalyzer', (refs: OfficialReferenceResolver) => new DependencyAnalyzer(refs)],
    ['PerformanceAnalyzer', (refs: OfficialReferenceResolver) => new PerformanceAnalyzer(refs)],
    ['DocumentationAnalyzer', (refs: OfficialReferenceResolver) => new DocumentationAnalyzer(refs)],
    ['AccessibilityAnalyzer', (refs: OfficialReferenceResolver) => new AccessibilityAnalyzer(refs)],
  ] as const)(
    'within a single analyzer\'s own output: %s',
    async (_label, buildEngine) => {
      const snapshot = await buildSnapshot();
      const storePath = path.join(tempDir!, 'k.sqlite');
      const store = createSqliteKnowledgeStore(storePath);
      const refs = new OfficialReferenceResolver(store);

      const engine: EngineUnderTest['engine'] = buildEngine(refs);
      const result = await engine.analyze(snapshot);

      const duplicates = findDuplicateFindingCodes(result.findings);
      expect(duplicates).toEqual([]);

      store.close();
    },
  );
});

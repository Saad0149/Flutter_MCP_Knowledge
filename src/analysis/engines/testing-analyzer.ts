import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import { OfficialReferenceResolver } from '../official-refs.js';
import type {
  AnalysisFinding,
  AnalyzerResult,
  ProjectAnalysisEngine,
  ProjectSnapshot,
} from '../types.js';
import { finding } from './finding-factory.js';

export interface TestingAnalyzerFacts {
  readonly testFileCount: number;
  readonly libFileCount: number;
  readonly testToLibRatio: number;
  readonly widgetTestCount: number;
  readonly unitTestCount: number;
  readonly integrationTestCount: number;
  readonly goldenTestCount: number;
  readonly mockUsageCount: number;
  readonly testedFeatures: readonly string[];
  readonly untestedFeatures: readonly string[];
  readonly testFrameworks: readonly string[];
  readonly coverageScore: number;
}

@injectable()
export class TestingAnalyzer implements ProjectAnalysisEngine<TestingAnalyzerFacts> {
  readonly name = 'testing';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<TestingAnalyzerFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;

    const libFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('lib/'));
    const testFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('test/'));

    const widgetTestFiles = testFiles.filter((f) =>
      f.content.includes('testWidgets') || f.relativePath.includes('widget_test'),
    );
    const integrationFiles = testFiles.filter(
      (f) =>
        f.relativePath.includes('integration') ||
        f.content.includes('IntegrationTestWidgetsFlutterBinding'),
    );
    const goldenFiles = testFiles.filter(
      (f) => f.content.includes('matchesGoldenFile') || f.relativePath.includes('golden'),
    );
    const unitFiles = testFiles.filter(
      (f) =>
        !widgetTestFiles.includes(f) &&
        !integrationFiles.includes(f) &&
        !goldenFiles.includes(f),
    );

    const mockUsageCount = testFiles.filter(
      (f) => f.content.includes('MockitoAnnotations') || f.content.includes('when(') || f.content.includes("'package:mockito") || f.content.includes("'package:mocktail"),
    ).length;

    const testToLibRatio = libFiles.length === 0 ? 0 : testFiles.length / libFiles.length;

    const testFrameworks: string[] = [];
    if (testFiles.some((f) => f.content.includes("'package:mockito"))) testFrameworks.push('mockito');
    if (testFiles.some((f) => f.content.includes("'package:mocktail"))) testFrameworks.push('mocktail');
    if (testFiles.some((f) => f.content.includes("'package:bloc_test"))) testFrameworks.push('bloc_test');
    if (testFiles.some((f) => f.content.includes("'package:integration_test"))) testFrameworks.push('integration_test');
    if (snapshot.devDependencies.includes('flutter_test') || snapshot.devDependencies.includes('test')) {
      testFrameworks.push('flutter_test');
    }

    const testedFeatures = extractTestedFeatures(testFiles);
    const untestedFeatures = extractUntestedFeatures(snapshot, testedFeatures);

    const coverageScore = computeCoverageScore({
      testToLibRatio,
      widgetTestCount: widgetTestFiles.length,
      integrationCount: integrationFiles.length,
      goldenCount: goldenFiles.length,
      libFileCount: libFiles.length,
    });

    const facts: TestingAnalyzerFacts = {
      testFileCount: testFiles.length,
      libFileCount: libFiles.length,
      testToLibRatio: Math.round(testToLibRatio * 100) / 100,
      widgetTestCount: widgetTestFiles.length,
      unitTestCount: unitFiles.length,
      integrationTestCount: integrationFiles.length,
      goldenTestCount: goldenFiles.length,
      mockUsageCount,
      testedFeatures,
      untestedFeatures,
      testFrameworks,
      coverageScore,
    };

    if (testFiles.length === 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'testing',
            code: 'NoTestSuite',
            title: 'No test suite found',
            description: `${libFiles.length} lib files exist with zero tests under test/.`,
            evidence: [`libFiles=${libFiles.length}`, 'test/ dart files=0'],
            recommendedFix: 'Start with widget tests for key screens, unit tests for repositories and use-cases.',
            officialReference: this.refs.lookupDoc('testing'),
            source: 'filesystem',
            confidence: 1.0,
            basis: 'ast',
            scoreImpact: -20,
            whyItMatters: 'Without tests, refactoring and dependency updates carry high regression risk.',
          },
          ast,
        ),
      );
    } else {
      if (testToLibRatio < 0.1) {
        findings.push(
          finding(
            {
              severity: 'warning',
              category: 'testing',
              code: 'LowTestRatio',
              title: `Low test coverage ratio: ${Math.round(testToLibRatio * 100)}%`,
              description: `Only ${testFiles.length} test files cover ${libFiles.length} lib files (${Math.round(testToLibRatio * 100)}% ratio).`,
              evidence: [`testFiles=${testFiles.length}`, `libFiles=${libFiles.length}`, `ratio=${Math.round(testToLibRatio * 100)}%`],
              recommendedFix: 'Target at least 1 test file per feature. Prioritize domain and repository layers.',
              source: 'filesystem',
              confidence: 0.9,
              basis: 'ast',
              scoreImpact: -10,
            },
            ast,
          ),
        );
      } else if (testToLibRatio >= 0.3) {
        findings.push(
          finding(
            {
              severity: 'positive',
              category: 'testing',
              code: 'GoodTestRatio',
              title: `Good test coverage ratio: ${Math.round(testToLibRatio * 100)}%`,
              description: `${testFiles.length} test files cover ${libFiles.length} lib files.`,
              evidence: [`ratio=${Math.round(testToLibRatio * 100)}%`],
              recommendedFix: null,
              source: 'filesystem',
              confidence: 0.9,
              basis: 'ast',
              scoreImpact: 10,
            },
            ast,
          ),
        );
      }

      if (widgetTestFiles.length > 0) {
        findings.push(
          finding(
            {
              severity: 'positive',
              category: 'testing',
              code: 'HasWidgetTests',
              title: `${widgetTestFiles.length} widget test file(s) found`,
              description: 'Widget tests verify UI behavior without a device.',
              evidence: [`widgetTests=${widgetTestFiles.length}`],
              recommendedFix: null,
              officialReference: this.refs.lookupDoc('widget tests'),
              source: 'filesystem',
              confidence: 0.95,
              basis: 'ast',
              scoreImpact: 8,
            },
            ast,
          ),
        );
      } else {
        findings.push(
          finding(
            {
              severity: 'warning',
              category: 'testing',
              code: 'NoWidgetTests',
              title: 'No widget tests (testWidgets) detected',
              description: 'Widget tests are the primary Flutter testing mechanism and catch UI regressions early.',
              evidence: [`testFiles=${testFiles.length}`, 'testWidgets=0'],
              recommendedFix: 'Add testWidgets tests for key screens and interactive widgets.',
              officialReference: this.refs.lookupDoc('testing widgets'),
              source: 'filesystem',
              confidence: 0.9,
              basis: 'ast',
              scoreImpact: -8,
            },
            ast,
          ),
        );
      }

      if (goldenFiles.length > 0) {
        findings.push(
          finding(
            {
              severity: 'positive',
              category: 'testing',
              code: 'HasGoldenTests',
              title: `${goldenFiles.length} golden test file(s) — visual regression protection`,
              description: 'Golden tests catch unintended UI changes across builds.',
              evidence: [`goldenFiles=${goldenFiles.length}`],
              recommendedFix: null,
              source: 'filesystem',
              confidence: 0.9,
              basis: 'ast',
              scoreImpact: 6,
            },
            ast,
          ),
        );
      }

      if (integrationFiles.length > 0) {
        findings.push(
          finding(
            {
              severity: 'positive',
              category: 'testing',
              code: 'HasIntegrationTests',
              title: `${integrationFiles.length} integration test file(s) found`,
              description: 'Integration tests verify end-to-end user flows.',
              evidence: [`integrationFiles=${integrationFiles.length}`],
              recommendedFix: null,
              source: 'filesystem',
              confidence: 0.9,
              basis: 'ast',
              scoreImpact: 8,
            },
            ast,
          ),
        );
      }

      if (untestedFeatures.length > 0) {
        findings.push(
          finding(
            {
              severity: 'warning',
              category: 'testing',
              code: 'UntestedFeatures',
              title: `${untestedFeatures.length} feature(s) appear to lack dedicated tests`,
              description: `Features without tests: ${untestedFeatures.slice(0, 5).join(', ')}.`,
              evidence: untestedFeatures.slice(0, 8).map((f) => `feature/${f} — no matching test`),
              recommendedFix: 'Add at least one test file per feature directory.',
              source: 'filesystem',
              confidence: 0.75,
              basis: 'ast',
              scoreImpact: -5,
            },
            ast,
          ),
        );
      }
    }

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

function extractTestedFeatures(testFiles: readonly { relativePath: string }[]): string[] {
  const features = new Set<string>();
  for (const f of testFiles) {
    const m = /(?:test|integration_test)\/(?:features\/)?([^/]+)\//i.exec(
      f.relativePath.replaceAll('\\', '/'),
    );
    if (m?.[1]) features.add(m[1]);
  }
  return [...features];
}

function extractUntestedFeatures(
  snapshot: ProjectSnapshot,
  testedFeatures: readonly string[],
): string[] {
  const allFeatures = new Set<string>();
  for (const f of snapshot.dartFiles) {
    const m = /lib\/features\/([^/]+)\//i.exec(f.relativePath.replaceAll('\\', '/'));
    if (m?.[1]) allFeatures.add(m[1]);
  }
  const testedSet = new Set(testedFeatures);
  return [...allFeatures].filter((f) => !testedSet.has(f));
}

function computeCoverageScore(input: {
  testToLibRatio: number;
  widgetTestCount: number;
  integrationCount: number;
  goldenCount: number;
  libFileCount: number;
}): number {
  if (input.libFileCount === 0) return 50;
  let score = Math.min(50, Math.round(input.testToLibRatio * 120));
  if (input.widgetTestCount > 0) score += Math.min(20, input.widgetTestCount * 3);
  if (input.integrationCount > 0) score += 15;
  if (input.goldenCount > 0) score += 10;
  return Math.min(100, score);
}

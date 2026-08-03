import { injectable } from 'tsyringe';
import type { AccessibilityFacts } from '../engines/accessibility-analyzer.js';
import type { ArchitectureFacts } from '../engines/architecture-analyzer.js';
import type { CodeQualityFacts } from '../engines/code-quality-analyzer.js';
import type { ComplexityFacts } from '../engines/complexity-analyzer.js';
import type { DependencyFacts } from '../engines/dependency-analyzer.js';
import type { DocumentationFacts } from '../engines/documentation-analyzer.js';
import type { PerformanceFacts } from '../engines/performance-analyzer.js';
import type { StateManagementFacts } from '../engines/state-management-analyzer.js';
import type { TestingAnalyzerFacts } from '../engines/testing-analyzer.js';
import type {
  AnalysisFinding,
  HealthScore,
  ProjectHealthReport,
  ProjectMetrics,
  ProjectSnapshot,
  ScoreContributor,
} from '../types.js';

/**
 * Transparent scoring — every score lists positive/negative contributors.
 * Replaces opaque numeric-only health scores while remaining back-compat.
 * New analyzer facts are optional to preserve backward compatibility.
 */
@injectable()
export class ScoringEngine {
  score(input: {
    readonly snapshot: ProjectSnapshot;
    readonly metrics: ProjectMetrics;
    readonly findings: readonly AnalysisFinding[];
    readonly architecture: ArchitectureFacts;
    readonly codeQuality: CodeQualityFacts;
    readonly stateManagement: StateManagementFacts;
    readonly complexity?: ComplexityFacts;
    readonly testing?: TestingAnalyzerFacts;
    readonly dependency?: DependencyFacts;
    readonly performance?: PerformanceFacts;
    readonly documentation?: DocumentationFacts;
    readonly accessibility?: AccessibilityFacts;
  }): ProjectHealthReport {
    const architecture = this.scoreArchitecture(input);
    const codeQuality = this.scoreCodeQuality(input);
    const stateManagement = this.scoreState(input);
    const testing = this.scoreTesting(input);
    const documentation = this.scoreDocumentation(input);
    const performance = this.scorePerformance(input);
    const accessibility = this.scoreAccessibility(input);
    const maintainability = compose(
      'maintainability',
      'Maintainability',
      [
        { score: architecture, weight: 0.4 },
        { score: codeQuality, weight: 0.35 },
        { score: stateManagement, weight: 0.25 },
      ],
      '0.4*architecture + 0.35*codeQuality + 0.25*stateManagement',
    );
    const scalability = this.scoreScalability(input);

    const scores = [
      architecture,
      codeQuality,
      stateManagement,
      testing,
      documentation,
      performance,
      accessibility,
      maintainability,
      scalability,
    ];

    const overall = compose(
      'overall',
      'Overall',
      [
        { score: architecture, weight: 0.2 },
        { score: codeQuality, weight: 0.2 },
        { score: stateManagement, weight: 0.15 },
        { score: testing, weight: 0.15 },
        { score: maintainability, weight: 0.15 },
        { score: scalability, weight: 0.15 },
      ],
      '0.2*architecture + 0.2*codeQuality + 0.15*stateManagement + 0.15*testing + 0.15*maintainability + 0.15*scalability',
    );

    return { scores, overall };
  }

  private scoreArchitecture(input: {
    readonly architecture: ArchitectureFacts;
    readonly findings: readonly AnalysisFinding[];
  }): HealthScore {
    const positives: ScoreContributor[] = [];
    const negatives: ScoreContributor[] = [];
    let value = 50;

    if (input.architecture.hasFeatures) {
      positives.push({
        label: 'Feature-first organization',
        delta: 20,
        findingCode: 'FeatureIsolationFolders',
      });
      value += 20;
    }
    if (input.architecture.hasDomain && input.architecture.hasData && input.architecture.hasPresentation) {
      positives.push({ label: 'Layer separation (domain/data/presentation)', delta: 15 });
      value += 15;
    }
    if (input.architecture.hasCore || input.architecture.hasShared) {
      positives.push({ label: 'Shared/core module present', delta: 8 });
      value += 8;
    }
    if (!input.architecture.presentationImportsData && !input.architecture.domainImportsData) {
      positives.push({ label: 'Healthy dependency direction signals', delta: 10 });
      value += 10;
    }
    if (input.architecture.circularDependencies.length === 0) {
      positives.push({ label: 'No circular imports detected', delta: 5 });
      value += 5;
    }

    if (input.architecture.presentationImportsData) {
      negatives.push({
        label: 'Presentation imports Data',
        delta: -12,
        findingCode: 'PresentationImportsData',
      });
      value -= 12;
    }
    if (input.architecture.domainImportsData) {
      negatives.push({ label: 'Domain imports Data', delta: -8, findingCode: 'DomainImportsData' });
      value -= 8;
    }
    if (input.architecture.domainImportsFlutter) {
      negatives.push({
        label: 'Domain imports Flutter',
        delta: -6,
        findingCode: 'DomainImportsFlutter',
      });
      value -= 6;
    }
    if (input.architecture.circularDependencies.length > 0) {
      negatives.push({
        label: `Circular imports (${input.architecture.circularDependencies.length})`,
        delta: -8,
        findingCode: 'CircularDependencies',
      });
      value -= 8;
    }
    if (input.architecture.testFileCount === 0) {
      negatives.push({ label: 'No tests under test/', delta: -5, findingCode: 'NoTests' });
      value -= 5;
    }

    return finalize(
      'architecture',
      'Architecture',
      value,
      positives,
      negatives,
      avgConfidence(input.findings, ['architecture', 'dependency']),
      'Base 50 + structural bonuses/penalties from measured architecture facts',
    );
  }

  private scoreCodeQuality(input: {
    readonly codeQuality: CodeQualityFacts;
    readonly findings: readonly AnalysisFinding[];
  }): HealthScore {
    const positives: ScoreContributor[] = [];
    const negatives: ScoreContributor[] = [];
    let value = 70;

    for (const f of input.findings) {
      if (!['oop', 'solid', 'dart', 'flutter', 'data_structures'].includes(f.category)) continue;
      const delta = Math.round((f.scoreImpact ?? 0) * f.confidence);
      if (delta === 0) continue;
      if (delta > 0) {
        positives.push({ label: f.title, delta, findingCode: f.code });
        value += delta;
      } else {
        negatives.push({ label: f.title, delta, findingCode: f.code });
        value += delta;
      }
    }

    if (input.codeQuality.godClassDetails?.length > 0) {
      ensureNegative(negatives, {
        label: `${input.codeQuality.godClassDetails.length} god-class candidates (multi-signal)`,
        delta: 0,
        findingCode: 'GodClassCandidate',
      });
    } else if ((input.codeQuality.largeClassCandidates?.length ?? 0) > 0) {
      ensureNegative(negatives, {
        label: `${input.codeQuality.largeClassCandidates.length} large class candidates (size only)`,
        delta: 0,
        findingCode: 'LargeClassCandidate',
      });
    }

    return finalize(
      'codeQuality',
      'Code Quality',
      value,
      positives,
      negatives,
      avgConfidence(input.findings, ['oop', 'solid', 'dart', 'flutter', 'data_structures']),
      'Base 70 + Σ(scoreImpact×confidence) for quality findings',
    );
  }

  private scoreState(input: {
    readonly stateManagement: StateManagementFacts;
    readonly findings: readonly AnalysisFinding[];
  }): HealthScore {
    const positives: ScoreContributor[] = [];
    const negatives: ScoreContributor[] = [];
    const value = Math.round(
      input.stateManagement.maintainabilityScore * 0.55 +
        input.stateManagement.scalabilityScore * 0.45,
    );

    positives.push({
      label: `Maintainability component ${input.stateManagement.maintainabilityScore}`,
      delta: Math.round(input.stateManagement.maintainabilityScore * 0.55),
    });
    positives.push({
      label: `Scalability component ${input.stateManagement.scalabilityScore}`,
      delta: Math.round(input.stateManagement.scalabilityScore * 0.45),
    });

    for (const f of input.findings.filter((x) => x.category === 'state_management')) {
      if ((f.scoreImpact ?? 0) < 0) {
        negatives.push({
          label: f.title,
          delta: Math.round((f.scoreImpact ?? 0) * f.confidence),
          findingCode: f.code,
        });
      }
    }

    return finalize(
      'stateManagement',
      'State Management',
      value,
      positives,
      negatives,
      avgConfidence(input.findings, ['state_management']),
      '0.55*maintainabilityScore + 0.45*scalabilityScore from state facts',
    );
  }

  private scoreTesting(input: {
    readonly metrics: ProjectMetrics;
    readonly findings: readonly AnalysisFinding[];
    readonly snapshot: ProjectSnapshot;
    readonly testing?: TestingAnalyzerFacts;
  }): HealthScore {
    const positives: ScoreContributor[] = [];
    const negatives: ScoreContributor[] = [];

    if (input.testing) {
      const t = input.testing;
      const value = t.coverageScore;
      const ratioPts = Math.round(Math.min(50, t.testToLibRatio * 120));
      positives.push({ label: `Test/lib ratio ${t.testFileCount}/${t.libFileCount}`, delta: ratioPts });
      if (t.widgetTestCount > 0) positives.push({ label: `${t.widgetTestCount} widget tests`, delta: Math.min(15, t.widgetTestCount * 3) });
      if (t.goldenTestCount > 0) positives.push({ label: `${t.goldenTestCount} golden tests`, delta: 10 });
      if (t.integrationTestCount > 0) positives.push({ label: `${t.integrationTestCount} integration tests`, delta: 15 });
      if (t.testFileCount === 0) negatives.push({ label: 'No test suite', delta: -20, findingCode: 'NoTestSuite' });
      else if (t.testToLibRatio < 0.1) negatives.push({ label: 'Low test/lib ratio', delta: -10, findingCode: 'LowTestRatio' });
      if (!t.widgetTestCount) negatives.push({ label: 'No widget tests', delta: -8, findingCode: 'NoWidgetTests' });
      return finalize('testing', 'Testing', value, positives, negatives, 0.9, 'TestingAnalyzer coverageScore (ratio + widget/golden/integration bonuses)');
    }

    // fallback: snapshot-based proxy
    const testFiles = input.snapshot.dartFiles.filter((f) => f.relativePath.startsWith('test/'));
    const widgetTests = testFiles.filter((f) => /widget_test|_test\.dart$/i.test(f.relativePath)).length;
    const goldenHints = testFiles.filter((f) => /golden/i.test(f.content) || /golden/i.test(f.relativePath)).length;
    const integrationHints = testFiles.filter(
      (f) => /integration/i.test(f.relativePath) || /IntegrationTestWidgetsFlutterBinding/.test(f.content),
    ).length;
    const unitish = Math.max(0, testFiles.length - integrationHints);

    const ratio =
      input.metrics.libFileCount === 0
        ? 0
        : input.metrics.testFileCount / input.metrics.libFileCount;

    let value = 15;
    const ratioPts = Math.round(Math.min(40, ratio * 120));
    value += ratioPts;
    positives.push({
      label: `File-to-test ratio ${input.metrics.testFileCount}/${input.metrics.libFileCount}`,
      delta: ratioPts,
    });

    if (widgetTests > 0) {
      const pts = Math.min(15, widgetTests * 2);
      value += pts;
      positives.push({ label: `Widget/unit-style tests≈${widgetTests}`, delta: pts });
    }
    if (goldenHints > 0) {
      value += 8;
      positives.push({ label: `Golden tests detected≈${goldenHints}`, delta: 8 });
    }
    if (integrationHints > 0) {
      value += 10;
      positives.push({ label: `Integration tests≈${integrationHints}`, delta: 10 });
    }
    if (unitish > 0 && widgetTests === 0) {
      value += 5;
      positives.push({ label: `Test files present≈${unitish}`, delta: 5 });
    }

    if (input.metrics.testFileCount === 0) {
      negatives.push({ label: 'No tests detected', delta: -20, findingCode: 'NoTests' });
      value = Math.max(0, value - 20);
    } else if (ratio < 0.05) {
      negatives.push({ label: 'Very low test/lib ratio', delta: -10, findingCode: 'NoTests' });
      value = Math.max(0, value - 10);
    }

    return finalize(
      'testing',
      'Testing',
      value,
      positives,
      negatives,
      input.metrics.testFileCount > 0 ? 0.85 : 0.7,
      '15 + capped ratio points + widget/golden/integration bonuses − sparse-suite penalties',
    );
  }

  private scoreDocumentation(input: {
    readonly snapshot: ProjectSnapshot;
    readonly codeQuality: CodeQualityFacts;
    readonly documentation?: DocumentationFacts;
  }): HealthScore {
    const positives: ScoreContributor[] = [];
    const negatives: ScoreContributor[] = [];

    if (input.documentation) {
      const value = input.documentation.documentationScore;
      const { widgetDocumentationRatio, classDocumentationRatio, hasReadme, hasAnalysisOptions } =
        input.documentation;
      if (widgetDocumentationRatio >= 0.9) {
        positives.push({ label: `Widget docs ${Math.round(widgetDocumentationRatio * 100)}%`, delta: 25 });
      } else {
        negatives.push({ label: `Undocumented widgets (${Math.round((1 - widgetDocumentationRatio) * 100)}%)`, delta: -Math.round((1 - widgetDocumentationRatio) * 25), findingCode: 'UndocumentedWidgets' });
      }
      if (classDocumentationRatio >= 0.8) {
        positives.push({ label: `Class docs ${Math.round(classDocumentationRatio * 100)}%`, delta: 15 });
      } else {
        negatives.push({ label: `Undocumented classes (${Math.round((1 - classDocumentationRatio) * 100)}%)`, delta: -Math.round((1 - classDocumentationRatio) * 15) });
      }
      if (hasReadme) positives.push({ label: 'README present', delta: 10 });
      else negatives.push({ label: 'No README', delta: -5, findingCode: 'MissingReadme' });
      if (hasAnalysisOptions) positives.push({ label: 'analysis_options.yaml', delta: 10 });
      else negatives.push({ label: 'No analysis_options.yaml', delta: -8, findingCode: 'MissingAnalysisOptions' });
      return finalize('documentation', 'Documentation', value, positives, negatives, 0.85, 'DocumentationAnalyzer score (widget/class doc ratio + project files)');
    }

    // fallback: proxy from code quality
    let value = 50;
    if (input.snapshot.hasAnalysisOptions) {
      positives.push({ label: 'analysis_options.yaml present', delta: 10 });
      value += 10;
    } else {
      negatives.push({ label: 'Missing analysis_options.yaml', delta: -10 });
      value -= 10;
    }
    if (input.codeQuality.undocumentedWidgets === 0 && input.codeQuality.widgetCount > 0) {
      positives.push({ label: 'Widgets documented', delta: 15 });
      value += 15;
    } else if (input.codeQuality.undocumentedWidgets > 0) {
      const pen = -Math.min(20, input.codeQuality.undocumentedWidgets);
      negatives.push({ label: `${input.codeQuality.undocumentedWidgets} undocumented widgets`, delta: pen });
      value += pen;
    }
    return finalize('documentation', 'Documentation', value, positives, negatives, 0.75, '50 ± analysis_options ± undocumented widget penalty (proxy)');
  }

  private scorePerformance(input: {
    readonly codeQuality: CodeQualityFacts;
    readonly performance?: PerformanceFacts;
  }): HealthScore {
    const positives: ScoreContributor[] = [];
    const negatives: ScoreContributor[] = [];

    if (input.performance) {
      const value = input.performance.performanceScore;
      if (input.performance.largeBuildMethodCount === 0) {
        positives.push({ label: 'No large build methods', delta: 5 });
      } else {
        const pen = -Math.min(20, input.performance.largeBuildMethodCount * 4);
        negatives.push({ label: `${input.performance.largeBuildMethodCount} large build methods`, delta: pen, findingCode: 'LargeBuildMethod' });
      }
      if (input.performance.heavySetStateCount > 0) {
        negatives.push({ label: `${input.performance.heavySetStateCount} heavy setState calls`, delta: -Math.min(15, input.performance.heavySetStateCount * 5), findingCode: 'HeavySetStateUsage' });
      }
      if (input.performance.animationControllerWithoutDisposeCount > 0) {
        negatives.push({ label: `${input.performance.animationControllerWithoutDisposeCount} AnimationController leak(s)`, delta: -Math.min(15, input.performance.animationControllerWithoutDisposeCount * 5), findingCode: 'AnimationControllerLeak' });
      }
      if (input.performance.constOpportunityCount > 20) {
        negatives.push({ label: 'Const widget opportunities missed', delta: -5, findingCode: 'ConstOpportunities' });
      }
      return finalize('performance', 'Performance', value, positives, negatives, 0.8, 'PerformanceAnalyzer score (build methods, const, setState, animation)');
    }

    // fallback: proxy from code quality
    let value = 75;
    const largePen = -Math.min(20, input.codeQuality.largeBuildMethods.length * 5);
    const constPen = -Math.min(15, Math.floor(input.codeQuality.missingConstCandidates / 20) * 5);
    if (largePen < 0) {
      negatives.push({ label: `${input.codeQuality.largeBuildMethods.length} large build methods`, delta: largePen, findingCode: 'LargeBuildMethod' });
      value += largePen;
    } else {
      positives.push({ label: 'No large build methods flagged', delta: 5 });
      value += 5;
    }
    if (constPen < 0) {
      negatives.push({ label: 'Const widget opportunities', delta: constPen, findingCode: 'ConstOpportunities' });
      value += constPen;
    }
    return finalize('performance', 'Performance', value, positives, negatives, 0.7, '75 - largeBuild - const penalties (proxy)');
  }

  private scoreAccessibility(input?: {
    readonly accessibility?: AccessibilityFacts;
  }): HealthScore {
    if (input?.accessibility) {
      const positives: ScoreContributor[] = [];
      const negatives: ScoreContributor[] = [];
      const acc = input.accessibility;
      if (acc.semanticsWidgetCount > 0) {
        positives.push({ label: `${acc.semanticsWidgetCount} Semantics widget(s)`, delta: Math.min(15, acc.semanticsWidgetCount * 2) });
      }
      if (acc.tooltipUsageCount > 0) {
        positives.push({ label: `${acc.tooltipUsageCount} Tooltip(s)`, delta: Math.min(10, acc.tooltipUsageCount) });
      }
      if (acc.imageWithoutSemanticLabel > 3) {
        negatives.push({ label: `${acc.imageWithoutSemanticLabel} images without semantic labels`, delta: -Math.min(20, acc.imageWithoutSemanticLabel * 2), findingCode: 'ImagesWithoutSemanticLabels' });
      }
      if (acc.iconButtonWithoutTooltip > 3) {
        negatives.push({ label: `${acc.iconButtonWithoutTooltip} IconButtons without tooltip`, delta: -Math.min(15, acc.iconButtonWithoutTooltip * 2), findingCode: 'IconButtonsWithoutTooltip' });
      }
      if (acc.semanticsWidgetCount === 0 && acc.tooltipUsageCount === 0) {
        negatives.push({ label: 'No accessibility annotations detected', delta: -12, findingCode: 'NoSemanticsWidgets' });
      }
      return finalize('accessibility', 'Accessibility', acc.accessibilityScore, positives, negatives, 0.75, 'AccessibilityAnalyzer score (Semantics, Tooltips, semantic labels)');
    }
    return finalize(
      'accessibility',
      'Accessibility',
      50,
      [],
      [{ label: 'Accessibility Analyzer not available', delta: 0 }],
      0.4,
      'Baseline 50 (proxy until AccessibilityAnalyzer runs)',
    );
  }

  private scoreScalability(input: {
    readonly architecture: ArchitectureFacts;
    readonly stateManagement: StateManagementFacts;
  }): HealthScore {
    const positives: ScoreContributor[] = [];
    const negatives: ScoreContributor[] = [];
    const value = Math.round(
      input.architecture.scalabilityScore * 0.6 + input.stateManagement.scalabilityScore * 0.4,
    );
    positives.push({
      label: `Architecture scalability ${input.architecture.scalabilityScore}`,
      delta: Math.round(input.architecture.scalabilityScore * 0.6),
    });
    positives.push({
      label: `State scalability ${input.stateManagement.scalabilityScore}`,
      delta: Math.round(input.stateManagement.scalabilityScore * 0.4),
    });
    if (input.architecture.circularDependencies.length > 0) {
      negatives.push({ label: 'Circular imports hurt scale-out', delta: -10 });
    }
    return finalize(
      'scalability',
      'Scalability',
      value,
      positives,
      negatives,
      0.85,
      '0.6*architecture.scalabilityScore + 0.4*state.scalabilityScore',
    );
  }
}

function finalize(
  id: string,
  label: string,
  value: number,
  positives: ScoreContributor[],
  negatives: ScoreContributor[],
  confidence: number,
  calculation: string,
): HealthScore {
  const clamped = clamp(value);
  return {
    id,
    label,
    value: clamped,
    max: 100,
    calculation,
    inputsUsed: [
      ...positives.map((p) => `+${p.delta} ${p.label}`),
      ...negatives.map((n) => `${n.delta} ${n.label}`),
      `confidence=${Math.round(confidence * 100)}%`,
    ],
    positiveContributors: positives,
    negativeContributors: negatives,
    weight: 1,
    confidence: round(confidence),
  };
}

function compose(
  id: string,
  label: string,
  parts: readonly { score: HealthScore; weight: number }[],
  calculation: string,
): HealthScore {
  const value = clamp(
    parts.reduce((sum, p) => sum + p.score.value * p.weight, 0),
  );
  const confidence = round(
    parts.reduce((sum, p) => sum + (p.score.confidence ?? 0.8) * p.weight, 0),
  );
  return {
    id,
    label,
    value,
    max: 100,
    calculation,
    inputsUsed: parts.map((p) => `${p.score.id}=${p.score.value} (w=${p.weight})`),
    positiveContributors: parts.map((p) => ({
      label: p.score.label,
      delta: Math.round(p.score.value * p.weight),
    })),
    negativeContributors: [],
    weight: 1,
    confidence,
  };
}

function avgConfidence(findings: readonly AnalysisFinding[], categories: string[]): number {
  const subset = findings.filter((f) => categories.includes(f.category));
  if (subset.length === 0) return 0.8;
  return round(subset.reduce((s, f) => s + f.confidence, 0) / subset.length);
}

function ensureNegative(list: ScoreContributor[], item: ScoreContributor): void {
  if (!list.some((x) => x.findingCode === item.findingCode)) {
    list.push(item);
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

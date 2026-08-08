import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import { ArchitectureMatchEngine } from '../engines/architecture-match-engine.js';
import { ArchitectureAnalyzer } from '../engines/architecture-analyzer.js';
import type { ArchitectureFacts } from '../engines/architecture-analyzer.js';
import { CodeQualityAnalyzer } from '../engines/code-quality-analyzer.js';
import type { CodeQualityFacts } from '../engines/code-quality-analyzer.js';
import { StateManagementAnalyzer } from '../engines/state-management-analyzer.js';
import type { StateManagementFacts } from '../engines/state-management-analyzer.js';
import { ComplexityAnalyzer } from '../engines/complexity-analyzer.js';
import type { ComplexityFacts } from '../engines/complexity-analyzer.js';
import { TestingAnalyzer } from '../engines/testing-analyzer.js';
import type { TestingAnalyzerFacts } from '../engines/testing-analyzer.js';
import { DependencyAnalyzer } from '../engines/dependency-analyzer.js';
import type { DependencyFacts } from '../engines/dependency-analyzer.js';
import { PerformanceAnalyzer } from '../engines/performance-analyzer.js';
import type { PerformanceFacts } from '../engines/performance-analyzer.js';
import { DocumentationAnalyzer } from '../engines/documentation-analyzer.js';
import type { DocumentationFacts } from '../engines/documentation-analyzer.js';
import { AccessibilityAnalyzer } from '../engines/accessibility-analyzer.js';
import type { AccessibilityFacts } from '../engines/accessibility-analyzer.js';
import { TechnicalDebtEngine } from '../debt/technical-debt-engine.js';
import { EvidenceEngine } from '../evidence/evidence-engine.js';
import { KnowledgeEngine } from '../knowledge/knowledge-engine.js';
import { MetricsEngine } from '../metrics/metrics-engine.js';
import { ProjectScanner } from '../project-scanner.js';
import { FindingRelationshipEngine } from '../relationships/finding-relationship-engine.js';
import { registerBuiltinAnalyzers } from '../rules/register-builtin.js';
import { RuleEngine } from '../rules/rule-engine.js';
import type {
  AnalysisFinding,
  AnalysisSummary,
  AnalyzerResult,
  ArchitectureMatch,
  ProjectHealthReport,
  ProjectHealthSections,
  ProjectInsight,
  ProjectMetrics,
  ProjectSnapshot,
  TechnicalDebtReport,
  PriorityAction,
} from '../types.js';
import { buildAnalysisSummary } from '../types.js';
import { ExplanationEngine } from './explanation-engine.js';
import { PriorityActionEngine } from './priority-action-engine.js';
import { ProjectHealthScorer } from './project-health-scorer.js';
import { RecommendationEngine } from './recommendation-engine.js';
import type { FindingRecommendation } from './recommendation-engine.js';

export interface ProjectAnalysisReport {
  readonly projectPath: string;
  readonly analysisSummary: AnalysisSummary;
  readonly insight: ProjectInsight;
  readonly health: ProjectHealthReport;
  readonly healthReport: ProjectHealthSections;
  readonly metrics: ProjectMetrics;
  readonly technicalDebt: TechnicalDebtReport;
  readonly topActions: readonly PriorityAction[];
  readonly architectureDetection: {
    readonly detected: ArchitectureMatch;
    readonly alternatives: readonly ArchitectureMatch[];
    readonly missingComponents: readonly string[];
    readonly folderStructure: readonly string[];
    readonly dependencyDirection: string;
  };
  readonly recommendations: readonly FindingRecommendation[];
  readonly results: {
    readonly architecture: AnalyzerResult<ArchitectureFacts>;
    readonly codeQuality: AnalyzerResult<CodeQualityFacts>;
    readonly stateManagement: AnalyzerResult<StateManagementFacts>;
    readonly complexity: AnalyzerResult<ComplexityFacts>;
    readonly testing: AnalyzerResult<TestingAnalyzerFacts>;
    readonly dependency: AnalyzerResult<DependencyFacts>;
    readonly performance: AnalyzerResult<PerformanceFacts>;
    readonly documentation: AnalyzerResult<DocumentationFacts>;
    readonly accessibility: AnalyzerResult<AccessibilityFacts>;
  };
  readonly findings: readonly AnalysisFinding[];
  readonly snapshot: ProjectSnapshot;
}

/**
 * Orchestrates all 9 analyzers, enrichment engines, and insight generators.
 * MCP handlers stay thin by calling this builder.
 */
@injectable()
export class ProjectReportBuilder {
  constructor(
    @inject(TYPES.ProjectScanner) private readonly scanner: ProjectScanner,
    @inject(TYPES.CodeQualityAnalyzer) private readonly codeQuality: CodeQualityAnalyzer,
    @inject(TYPES.StateManagementAnalyzer)
    private readonly stateManagement: StateManagementAnalyzer,
    @inject(TYPES.ArchitectureAnalyzer) private readonly architecture: ArchitectureAnalyzer,
    @inject(TYPES.MetricsEngine) private readonly metricsEngine: MetricsEngine,
    @inject(TYPES.ExplanationEngine) private readonly explanation: ExplanationEngine,
    @inject(TYPES.RecommendationEngine) private readonly recommendations: RecommendationEngine,
    @inject(TYPES.ProjectHealthScorer) private readonly healthScorer: ProjectHealthScorer,
    @inject(TYPES.RuleEngine) private readonly ruleEngine: RuleEngine,
    @inject(TYPES.EvidenceEngine) private readonly evidence: EvidenceEngine,
    @inject(TYPES.KnowledgeEngine) private readonly knowledge: KnowledgeEngine,
    @inject(TYPES.FindingRelationshipEngine)
    private readonly relationships: FindingRelationshipEngine,
    @inject(TYPES.TechnicalDebtEngine) private readonly debt: TechnicalDebtEngine,
    @inject(TYPES.ArchitectureMatchEngine)
    private readonly architectureMatches: ArchitectureMatchEngine,
    @inject(TYPES.PriorityActionEngine) private readonly priorityActions: PriorityActionEngine,
    @inject(TYPES.ComplexityAnalyzer) private readonly complexity: ComplexityAnalyzer,
    @inject(TYPES.TestingAnalyzer) private readonly testing: TestingAnalyzer,
    @inject(TYPES.DependencyAnalyzer) private readonly dependency: DependencyAnalyzer,
    @inject(TYPES.PerformanceAnalyzer) private readonly performance: PerformanceAnalyzer,
    @inject(TYPES.DocumentationAnalyzer) private readonly documentation: DocumentationAnalyzer,
    @inject(TYPES.AccessibilityAnalyzer) private readonly accessibility: AccessibilityAnalyzer,
  ) {
    registerBuiltinAnalyzers(this.ruleEngine, {
      codeQuality: this.codeQuality,
      stateManagement: this.stateManagement,
      architecture: this.architecture,
      complexity: this.complexity,
      testing: this.testing,
      dependency: this.dependency,
      performance: this.performance,
      documentation: this.documentation,
      accessibility: this.accessibility,
    });
  }

  async build(projectPath: string, limit = 200): Promise<ProjectAnalysisReport> {
    const snapshot = await this.scanner.scan(projectPath);

    const codeQuality = this.codeQuality.analyze(snapshot);
    const stateManagement = this.stateManagement.analyze(snapshot);
    const architecture = this.architecture.analyze(snapshot);
    const complexity = this.complexity.analyze(snapshot);
    const testing = this.testing.analyze(snapshot);
    const dependency = this.dependency.analyze(snapshot);
    const performance = this.performance.analyze(snapshot);
    const documentation = this.documentation.analyze(snapshot);
    const accessibility = this.accessibility.analyze(snapshot);

    let merged: AnalysisFinding[] = [
      ...codeQuality.findings,
      ...stateManagement.findings,
      ...architecture.findings,
      ...complexity.findings,
      ...testing.findings,
      ...dependency.findings,
      ...performance.findings,
      ...documentation.findings,
      ...accessibility.findings,
    ];

    merged = this.evidence.enrichAll(merged, snapshot);
    merged = this.knowledge.enrichAll(merged);
    merged = this.relationships.relate(merged);
    merged = merged.map((f) => ({
      ...f,
      priority: deriveFindingPriority(f),
    }));
    merged = merged.slice(0, limit);

    const metrics = this.metricsEngine.collect(snapshot, {
      architecture: architecture.facts,
      codeQuality: codeQuality.facts,
      stateManagement: stateManagement.facts,
    });

    const technicalDebt = this.debt.calculate({
      findings: merged,
      architecture: architecture.facts,
      codeQuality: codeQuality.facts,
      stateManagement: stateManagement.facts,
    });

    const architectureDetection = this.architectureMatches.match(architecture.facts);
    // ArchitectureMatchEngine is the single authoritative source for the
    // detected primary pattern (it scores ALL candidates and picks the
    // highest-confidence one). ArchitectureAnalyzer's own detectedArchitecture
    // field is only a single-candidate first-match guess used to seed that
    // scoring — realign the DetectedArchitecture finding to the authoritative
    // result so it never disagrees with architectureDetection.detected (Bug 2).
    merged = merged.map((f) =>
      f.code === 'DetectedArchitecture'
        ? {
            ...f,
            title: `Detected architecture: ${architectureDetection.detected.architecture}`,
            description: `Confidence ${architectureDetection.detected.confidence}% based on folder layout and import facts (not a guess).`,
            confidence: architectureDetection.detected.confidence / 100,
          }
        : f,
    );

    const analysisSummary = buildAnalysisSummary(snapshot.astMeta, merged);
    const insight = this.explanation.explain({
      snapshot,
      summary: analysisSummary,
      metrics,
      findings: merged,
      architecture: architecture.facts,
      codeQuality: codeQuality.facts,
      stateManagement: stateManagement.facts,
      technicalDebt,
      architectureDetection: architectureDetection.detected,
    });
    const health = this.healthScorer.score({
      snapshot,
      metrics,
      findings: merged,
      architecture: architecture.facts,
      codeQuality: codeQuality.facts,
      stateManagement: stateManagement.facts,
      complexity: complexity.facts,
      testing: testing.facts,
      dependency: dependency.facts,
      performance: performance.facts,
      documentation: documentation.facts,
      accessibility: accessibility.facts,
    });
    const projectRecommendations = this.recommendations.recommend(merged, merged);
    const topActions = this.priorityActions.build(merged, 5);

    const healthReport = buildHealthSections({
      insight,
      health,
      metrics,
      technicalDebt,
      analysisSummary,
      recommendations: projectRecommendations,
      findings: merged,
      architectureDetection,
      topActions,
    });

    return {
      projectPath: snapshot.projectPath,
      analysisSummary,
      insight,
      health,
      healthReport,
      metrics,
      technicalDebt,
      topActions,
      architectureDetection,
      recommendations: projectRecommendations,
      results: {
        architecture: {
          ...architecture,
          findings: this.sliceEngineFindings(architecture.findings, merged, limit),
        },
        codeQuality: {
          ...codeQuality,
          findings: this.sliceEngineFindings(codeQuality.findings, merged, limit),
        },
        stateManagement: {
          ...stateManagement,
          findings: this.sliceEngineFindings(stateManagement.findings, merged, limit),
        },
        complexity: {
          ...complexity,
          findings: this.sliceEngineFindings(complexity.findings, merged, limit),
        },
        testing: {
          ...testing,
          findings: this.sliceEngineFindings(testing.findings, merged, limit),
        },
        dependency: {
          ...dependency,
          findings: this.sliceEngineFindings(dependency.findings, merged, limit),
        },
        performance: {
          ...performance,
          findings: this.sliceEngineFindings(performance.findings, merged, limit),
        },
        documentation: {
          ...documentation,
          findings: this.sliceEngineFindings(documentation.findings, merged, limit),
        },
        accessibility: {
          ...accessibility,
          findings: this.sliceEngineFindings(accessibility.findings, merged, limit),
        },
      },
      findings: merged,
      snapshot,
    };
  }

  private sliceEngineFindings(
    original: readonly AnalysisFinding[],
    enriched: readonly AnalysisFinding[],
    limit: number,
  ): AnalysisFinding[] {
    const byCode = new Map(enriched.map((f) => [f.code, f]));
    return original
      .map((f) => byCode.get(f.code) ?? f)
      .slice(0, limit);
  }
}

export function deriveFindingPriority(
  f: AnalysisFinding,
): NonNullable<AnalysisFinding['priority']> {
  if (f.severity === 'info' || f.severity === 'positive') return 'info';
  const impact = Math.abs(f.scoreImpact ?? 0);
  if (impact >= 12 && f.confidence >= 0.9) {
    // A finding that can't cite a single file isn't presentable with 'critical'
    // authority — even at max impact/confidence, it's an aggregate count with
    // nothing to point an agent or developer at. Runs after evidence
    // enrichment, so evidenceItems are already populated here.
    return hasLocatableFileEvidence(f) ? 'critical' : 'high';
  }
  if (impact >= 8) return 'high';
  if (f.severity === 'warning') return 'medium';
  return 'medium';
}

/** Same "does this finding have a real file to point at" check sampleFilesFor uses. */
function hasLocatableFileEvidence(f: AnalysisFinding): boolean {
  if (f.file) return true;
  return (f.evidenceItems ?? []).some((item) => Boolean(item.file));
}

function buildHealthSections(input: {
  readonly insight: ProjectInsight;
  readonly health: ProjectHealthReport;
  readonly metrics: ProjectMetrics;
  readonly technicalDebt: TechnicalDebtReport;
  readonly analysisSummary: AnalysisSummary;
  readonly recommendations: readonly FindingRecommendation[];
  readonly findings: readonly AnalysisFinding[];
  readonly architectureDetection: ProjectAnalysisReport['architectureDetection'];
  readonly topActions: readonly PriorityAction[];
}): ProjectHealthSections {
  const evidenceCount = input.findings.reduce(
    (sum, f) => sum + (f.evidenceItems?.length ?? f.evidence.length),
    0,
  );

  const positives = input.findings
    .filter((f) => f.severity === 'positive')
    .slice(0, 8)
    .map((f) => f.title);

  return {
    overview: [
      input.insight.overview,
      input.topActions.length > 0
        ? `Top action: ${input.topActions[0]!.title} (${input.topActions[0]!.impact} impact).`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    architecture: [
      input.insight.architecture,
      `Detected=${input.architectureDetection.detected.architecture} (${input.architectureDetection.detected.confidence}%).`,
      input.architectureDetection.alternatives.length > 0
        ? `Alternatives: ${input.architectureDetection.alternatives
            .map((a) => `${a.architecture} ${a.confidence}%`)
            .join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    metrics: `${input.metrics.libFileCount} lib files, ${input.metrics.widgetCount} widgets, ${input.metrics.classCount} classes, ${input.metrics.featureCount} features, ${input.metrics.testFileCount} tests, ${input.metrics.linesOfCode} LOC, ${input.metrics.packageDependencyCount} packages.`,
    technicalDebt: input.technicalDebt.summary,
    topRisks: input.insight.topRisks,
    topStrengths: positives.length > 0 ? positives : input.insight.strengths,
    topActions: input.topActions.map((a) => {
      const gains = a.expectedScoreGains.map((g) => `${g.category} +${g.delta}`).join(', ');
      return `${a.rank}. ${a.title} — Impact: ${a.impact}, Effort: ${a.effort}${gains ? `, ${gains}` : ''}`;
    }),
    categoryScores: [...input.health.scores, input.health.overall],
    confidence: input.analysisSummary.confidence,
    recommendations: input.recommendations.slice(0, 8).map((r) => {
      return `[${r.priority}] ${r.problem} — ${r.suggestedFix ?? r.suggestedRefactor}`;
    }),
    trendSummary:
      'Trend is unknown until consecutive analyses are stored; debt trend currently reports "unknown".',
    evidenceSummary: `${evidenceCount} structured evidence item(s) across ${input.findings.length} finding(s); AST source=${input.analysisSummary.astSource}, coverage=${input.analysisSummary.coverage}.`,
  };
}

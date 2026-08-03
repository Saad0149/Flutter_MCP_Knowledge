import type { AnalysisFinding, HealthScore, PriorityAction } from '../types.js';
import type { ProjectAnalysisReport } from '../insight/project-report-builder.js';

/** Compact finding card for chat — no nested evidence dumps. */
export interface FindingCard {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly severity: AnalysisFinding['severity'];
  readonly category: AnalysisFinding['category'];
  readonly confidence: number;
  readonly priority?: AnalysisFinding['priority'];
  readonly scoreImpact?: number;
}

export interface ScoreCard {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly confidence?: number;
  readonly topPositives: readonly string[];
  readonly topNegatives: readonly string[];
}

export interface ReviewProjectSummary {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly overallHealth: number;
  readonly confidence: number;
  readonly astSource: string;
  readonly coverage: string;
  readonly overview: string;
  readonly topRisks: readonly string[];
  readonly topStrengths: readonly string[];
  readonly topActions: readonly PriorityAction[];
  readonly scores: readonly ScoreCard[];
  readonly technicalDebt: {
    readonly debtScore: number;
    readonly estimatedRefactoringCost: string;
    readonly majorContributors: readonly string[];
  };
  readonly findingCount: number;
  readonly findingCodes: readonly FindingCard[];
  readonly usage: {
    readonly next: string;
    readonly note: string;
  };
}

export function toFindingCard(f: AnalysisFinding): FindingCard {
  return {
    id: f.id ?? f.code,
    code: f.code,
    title: f.title,
    severity: f.severity,
    category: f.category,
    confidence: f.confidence,
    priority: f.priority,
    scoreImpact: f.scoreImpact,
  };
}

export function toScoreCard(s: HealthScore): ScoreCard {
  return {
    id: s.id,
    label: s.label,
    value: s.value,
    max: s.max,
    confidence: s.confidence,
    topPositives: (s.positiveContributors ?? []).slice(0, 3).map((c) => `+${c.delta} ${c.label}`),
    topNegatives: (s.negativeContributors ?? [])
      .filter((c) => c.delta !== 0)
      .slice(0, 3)
      .map((c) => `${c.delta} ${c.label}`),
  };
}

export function buildReviewSummary(
  sessionId: string,
  report: Omit<ProjectAnalysisReport, 'snapshot'>,
): ReviewProjectSummary {
  const cards = report.findings.map(toFindingCard);
  return {
    sessionId,
    projectPath: report.projectPath,
    overallHealth: report.health.overall.value,
    confidence: report.analysisSummary.confidence,
    astSource: report.analysisSummary.astSource,
    coverage: report.analysisSummary.coverage,
    overview: report.insight.overview,
    topRisks: report.healthReport.topRisks.slice(0, 5),
    topStrengths: report.healthReport.topStrengths.slice(0, 5),
    topActions: report.topActions.slice(0, 5),
    scores: [...report.health.scores, report.health.overall].map(toScoreCard),
    technicalDebt: {
      debtScore: report.technicalDebt.debtScore,
      estimatedRefactoringCost: report.technicalDebt.estimatedRefactoringCost,
      majorContributors: report.technicalDebt.majorContributors.slice(0, 6),
    },
    findingCount: report.findings.length,
    findingCodes: cards
      .filter((c) => c.severity === 'negative' || c.severity === 'warning')
      .slice(0, 15),
    usage: {
      next: 'Pass sessionId to analyze_architecture / analyze_code_quality / analyze_state_management / explain_finding / explore_finding — no rescan.',
      note: 'Set detail="full" on review_project only if you explicitly need the entire report in chat.',
    },
  };
}

export function filterFindingsByCategory(
  findings: readonly AnalysisFinding[],
  categories: readonly string[],
): AnalysisFinding[] {
  return findings.filter((f) => categories.includes(f.category));
}

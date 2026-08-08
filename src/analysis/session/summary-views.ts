import type { AnalysisFinding, FindingBasis, HealthScore, PriorityAction } from '../types.js';
import type { ProjectAnalysisReport } from '../insight/project-report-builder.js';
import { hasEvidenceFor, sampleFilesFor } from '../../tools/tool-response-helpers.js';

export interface TopRiskCard {
  readonly title: string;
  readonly sampleFiles: readonly string[];
  /**
   * False when the underlying finding has no evidence at all to draw file
   * paths from (distinct from having evidence that just isn't file-shaped —
   * an empty sampleFiles with hasEvidence:true is a legitimate "no files to
   * show", not a gap).
   */
  readonly hasEvidence: boolean;
  /**
   * False when the finding has evidence (hasEvidence may still be true) but
   * none of it names a real file — e.g. an aggregate count like "113
   * problematic setState sites" with no per-instance location tracked
   * anywhere in the analyzer. Equivalent to sampleFiles.length > 0. A finding
   * presented here with hasLocatableEvidence:false is asserting a risk it
   * cannot point a reader at — treat it with appropriately less authority
   * than one that can.
   */
  readonly hasLocatableEvidence: boolean;
  /**
   * WHY the confidence above is what it is — 'pattern' means "this is
   * inherently a heuristic check, expected"; 'heuristic_fallback' means
   * "this specific finding needed real AST data and didn't get it this
   * scan" (worth a check_environment call); 'ast' means grounded in a
   * deterministic structural fact. See FindingBasis.
   */
  readonly basis: FindingBasis;
}

export interface TopActionCard extends PriorityAction {
  readonly sampleFiles: readonly string[];
  readonly hasEvidence: boolean;
  readonly hasLocatableEvidence: boolean;
  readonly basis?: FindingBasis;
}

/** Compact finding card for chat — no nested evidence dumps. */
export interface FindingCard {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly severity: AnalysisFinding['severity'];
  readonly category: AnalysisFinding['category'];
  readonly confidence: number;
  /** WHY confidence is what it is — see FindingBasis. */
  readonly basis: FindingBasis;
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
  /** True when `value` is a floor/ceiling clamp of a more extreme raw score. */
  readonly clamped?: boolean;
  /** The pre-clamp computed value. Only present when `clamped` is true. */
  readonly rawValue?: number;
}

export interface ReviewProjectSummary {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly overallHealth: number;
  readonly confidence: number;
  readonly astSource: string;
  readonly coverage: string;
  /**
   * Present and prominent (not buried) whenever analysis ran in degraded/heuristic
   * mode, so callers can't miss that findings have reduced confidence.
   */
  readonly fidelityNotice?: string;
  readonly overview: string;
  /**
   * Internally-detected inconsistencies in this report — e.g. a score that
   * clamped to a floor/ceiling despite net-opposite listed contributors, or
   * two fields disagreeing on the primary detected architecture pattern.
   * Present only when a check actually fails; absent otherwise. A safety
   * net for regressions of this class of bug, not a substitute for fixing
   * the underlying cause.
   */
  readonly dataQualityWarnings?: readonly string[];
  readonly topRisks: readonly TopRiskCard[];
  readonly topStrengths: readonly string[];
  readonly topActions: readonly TopActionCard[];
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
    basis: f.basis,
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
    ...(s.clamped ? { clamped: true, rawValue: s.rawValue } : {}),
  };
}

function severityRank(severity: AnalysisFinding['severity']): number {
  switch (severity) {
    case 'negative':
      return 4;
    case 'warning':
      return 3;
    case 'info':
      return 1;
    case 'positive':
      return 0;
    default:
      return 0;
  }
}

/** Same ranking ExplanationEngine uses for topRisks, but keeping the real
 * finding object (not just a formatted string) so we can attach sampleFiles
 * drawn from its actual evidence. */
function topRiskCards(findings: readonly AnalysisFinding[], max: number): TopRiskCard[] {
  return [...findings]
    .filter((f) => f.severity === 'negative' || f.severity === 'warning')
    .sort((a, b) => severityRank(b.severity) * b.confidence - severityRank(a.severity) * a.confidence)
    .slice(0, max)
    .map((f) => {
      const sampleFiles = sampleFilesFor(f);
      return {
        title: `${f.title} (confidence ${(f.confidence * 100).toFixed(0)}%, basis=${f.basis}, source=${f.source})`,
        sampleFiles,
        hasEvidence: hasEvidenceFor(f),
        hasLocatableEvidence: sampleFiles.length > 0,
        basis: f.basis,
      };
    });
}

function topActionCards(
  actions: readonly PriorityAction[],
  findings: readonly AnalysisFinding[],
  max: number,
): TopActionCard[] {
  const byCode = new Map(findings.map((f) => [f.code, f]));
  return actions.slice(0, max).map((action) => {
    const finding = byCode.get(action.findingCode);
    const sampleFiles = sampleFilesFor(finding);
    return {
      ...action,
      sampleFiles,
      hasEvidence: hasEvidenceFor(finding),
      hasLocatableEvidence: sampleFiles.length > 0,
      basis: finding?.basis,
    };
  });
}

export function buildReviewSummary(
  sessionId: string,
  report: Omit<ProjectAnalysisReport, 'snapshot'>,
): ReviewProjectSummary {
  const cards = report.findings.map(toFindingCard);
  const isDegraded =
    report.analysisSummary.astSource === 'heuristic' || report.analysisSummary.coverage !== 'full';
  const dataQualityWarnings = [
    ...checkScoreClampSanity(report.health.scores),
    ...checkArchitectureAgreement(report),
  ];

  return {
    sessionId,
    projectPath: report.projectPath,
    overallHealth: report.health.overall.value,
    confidence: report.analysisSummary.confidence,
    astSource: report.analysisSummary.astSource,
    coverage: report.analysisSummary.coverage,
    fidelityNotice: isDegraded
      ? `Analysis fidelity is reduced (astSource="${report.analysisSummary.astSource}", coverage="${report.analysisSummary.coverage}"). ` +
        `Findings and scores reflect heuristic (regex-based) extraction, not the full Dart AST. ` +
        (report.analysisSummary.warning
          ? `Reason: ${report.analysisSummary.warning} `
          : '') +
        `Call check_environment to see why the Dart analyzer wasn't used and how to fix it.`
      : undefined,
    overview: report.insight.overview,
    ...(dataQualityWarnings.length > 0 ? { dataQualityWarnings } : {}),
    topRisks: topRiskCards(report.findings, 5),
    topStrengths: report.healthReport.topStrengths.slice(0, 5),
    topActions: topActionCards(report.topActions, report.findings, 5),
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

/**
 * Regression guard for Bug 1 (0/100 code-quality score with net-positive
 * listed contributors): flags any score that landed on its floor/ceiling
 * while its own listed contributors point the other way. `clamped`/`rawValue`
 * (set by ScoringEngine's finalize/compose) tell us the value really was
 * clamped, not just coincidentally equal to 0 or max.
 */
export function checkScoreClampSanity(scores: readonly HealthScore[]): string[] {
  const warnings: string[] = [];
  for (const s of scores) {
    if (!s.clamped) continue;
    const positiveSum = (s.positiveContributors ?? []).reduce((sum, c) => sum + c.delta, 0);
    const negativeSum = (s.negativeContributors ?? []).reduce((sum, c) => sum + c.delta, 0);
    if (s.value === 0 && positiveSum > Math.abs(negativeSum)) {
      warnings.push(
        `${s.label} score clamped to 0 (raw ${s.rawValue}) despite net-positive listed contributors ` +
          `(+${positiveSum} vs ${negativeSum}) — the shown positives don't obviously explain the floor.`,
      );
    } else if (s.value === s.max && negativeSum < -Math.abs(positiveSum)) {
      warnings.push(
        `${s.label} score clamped to ${s.max} (raw ${s.rawValue}) despite net-negative listed contributors ` +
          `(+${positiveSum} vs ${negativeSum}) — the shown negatives don't obviously explain the ceiling.`,
      );
    }
  }
  return warnings;
}

/**
 * Regression guard for Bug 2 (review_project narrative and analyze_architecture
 * disagreeing on the primary detected pattern): both now derive from
 * ArchitectureMatchEngine's result (architectureDetection.detected), but this
 * check catches any future re-divergence rather than silently shipping it.
 */
export function checkArchitectureAgreement(
  report: Pick<ProjectAnalysisReport, 'findings' | 'architectureDetection'>,
): string[] {
  if (!report.architectureDetection?.detected) return [];
  const detectedFinding = report.findings.find((f) => f.code === 'DetectedArchitecture');
  const primary = report.architectureDetection.detected.architecture;
  if (detectedFinding && !detectedFinding.title.includes(primary)) {
    return [
      `Architecture detection disagreement: the DetectedArchitecture finding says "${detectedFinding.title}" ` +
        `but the authoritative match (ArchitectureMatchEngine) is "${primary}" (${report.architectureDetection.detected.confidence}%).`,
    ];
  }
  return [];
}

export function filterFindingsByCategory(
  findings: readonly AnalysisFinding[],
  categories: readonly string[],
): AnalysisFinding[] {
  return findings.filter((f) => categories.includes(f.category));
}

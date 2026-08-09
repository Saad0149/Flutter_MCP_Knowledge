import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import {
  AnalysisSessionStore,
  type StoredAnalysisSession,
} from '../analysis/session/analysis-session-store.js';
import {
  buildReviewSummary,
  severityRank,
  toScoreCard,
  type ReviewProjectSummary,
  type ScoreCard,
} from '../analysis/session/summary-views.js';
import type { AnalysisFinding, ProjectAnalysisReport } from '../analysis/index.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import {
  ExplainFindingHandler,
  type ExplainFindingResult,
} from './explain-finding.js';
import { resolveShapeOptions } from './finding-response-shape.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';
import {
  checkAnalyzableSession,
  sampleFilesFor,
  withSizeMetadata,
  type Sized,
  type SizedBlockedResult,
} from './tool-response-helpers.js';

export const ReviewProjectInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe('Absolute or relative path to a Flutter/Dart project root'),
  limit: z.number().int().positive().max(300).optional(),
  detail: z
    .enum(['summary', 'full'])
    .optional()
    .describe('summary (default) = executive health + sessionId; full = legacy large payload'),
  explainTopFindings: z
    .boolean()
    .optional()
    .describe(
      'Default false. When true, attaches a brief explanation (summary + fix + top evidence) to ' +
        "each of the 9 analyzers' single top finding under topFindingsByAnalyzer — score + top " +
        'finding + fix + evidence for all 9 categories in this one call, reading only the ' +
        'already-cached scan (no rescanning). Use this when the caller wants an actionable report ' +
        'in one call rather than needing review_project + 9x analyze_* + Nx explain_finding round trips.',
    ),
});

export type ReviewProjectInput = z.infer<typeof ReviewProjectInputSchema>;

/**
 * The 9 analyzer engines and, where one exists, the HealthScore id each
 * feeds. complexity and dependency have no dedicated score component in
 * ScoringEngine (their findings feed other scores instead), so their entry
 * carries score: undefined rather than a fabricated one.
 */
const ANALYZER_SCORE_IDS: ReadonlyArray<
  readonly [keyof ProjectAnalysisReport['results'], string | undefined]
> = [
  ['architecture', 'architecture'],
  ['codeQuality', 'codeQuality'],
  ['stateManagement', 'stateManagement'],
  ['complexity', undefined],
  ['testing', 'testing'],
  ['dependency', undefined],
  ['performance', 'performance'],
  ['documentation', 'documentation'],
  ['accessibility', 'accessibility'],
];

export interface AnalyzerTopFindingEntry {
  readonly analyzer: string;
  readonly score: ScoreCard | undefined;
  readonly topFindingCode: string | undefined;
  /**
   * Whether the top finding (if any) names a real file — see the
   * hasLocatableEvidence work. False here is not suppressed: the attached
   * explanation's evidence array is genuinely empty in that case, exactly
   * as a direct explain_finding call on that finding would return it.
   */
  readonly hasLocatableEvidence: boolean;
  readonly topFindingExplained: ExplainFindingResult | undefined;
}

export type ReviewProjectSummaryWithExplanations = ReviewProjectSummary & {
  readonly topFindingsByAnalyzer: readonly AnalyzerTopFindingEntry[];
};

export type ReviewProjectData =
  | ReviewProjectSummary
  | ReviewProjectSummaryWithExplanations
  | (Omit<ProjectAnalysisReport, 'snapshot'> & { readonly sessionId: string });

export type ReviewProjectResult = Sized<ReviewProjectData> | SizedBlockedResult;

@injectable()
export class ReviewProjectHandler {
  constructor(
    @inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore,
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.ExplainFindingHandler) private readonly explainFinding: ExplainFindingHandler,
  ) {}

  async execute(input: ReviewProjectInput): Promise<ToolResult<ReviewProjectResult>> {
    try {
      const parsed = ReviewProjectInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for review_project',
          details: parsed.error.flatten(),
        });
      }

      const { session } = await this.sessions.resolve({
        path: parsed.data.path,
        limit: parsed.data.limit ?? 200,
        forceRefresh: true,
      });

      this.logger.info('Project review orchestration complete', {
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        findings: session.report.findings.length,
        detail: parsed.data.detail ?? 'summary',
      });

      const blocked = checkAnalyzableSession(session);
      if (blocked) {
        return toolOk(withSizeMetadata(blocked));
      }

      if (parsed.data.detail === 'full') {
        return toolOk(
          withSizeMetadata({
            sessionId: session.sessionId,
            ...session.report,
          }),
        );
      }

      const summary = buildReviewSummary(session.sessionId, session.report);
      if (!parsed.data.explainTopFindings) {
        return toolOk(withSizeMetadata(summary));
      }

      const withExplanations: ReviewProjectSummaryWithExplanations = {
        ...summary,
        topFindingsByAnalyzer: this.buildTopFindingsByAnalyzer(session),
      };
      return toolOk(withSizeMetadata(withExplanations));
    } catch (error) {
      return toolFail(error);
    }
  }

  /**
   * Reuses ExplainFindingHandler.buildOne against the session already
   * resolved above — no additional sessions.resolve()/rescan, no analyzer
   * re-run. Picks each analyzer's single top finding with the same
   * severity/confidence ranking review_project's own topRisks already uses.
   */
  private buildTopFindingsByAnalyzer(session: StoredAnalysisSession): AnalyzerTopFindingEntry[] {
    const briefShape = resolveShapeOptions({ verbosity: 'brief', maxEvidence: 3 });
    const scores = session.report.health.scores;

    return ANALYZER_SCORE_IDS.map(([analyzer, scoreId]) => {
      const engineFindings = session.report.results[analyzer].findings;
      const topFinding = pickTopFinding(engineFindings);
      const score = scoreId ? scores.find((s) => s.id === scoreId) : undefined;

      if (!topFinding) {
        return {
          analyzer,
          score: score ? toScoreCard(score) : undefined,
          topFindingCode: undefined,
          hasLocatableEvidence: false,
          topFindingExplained: undefined,
        };
      }

      const explained = this.explainFinding.buildOne(
        session,
        topFinding.code,
        topFinding.id,
        briefShape,
      );

      return {
        analyzer,
        score: score ? toScoreCard(score) : undefined,
        topFindingCode: topFinding.code,
        hasLocatableEvidence: sampleFilesFor(topFinding).length > 0,
        topFindingExplained: explained.status === 'not_found' ? undefined : explained,
      };
    });
  }
}

function pickTopFinding(findings: readonly AnalysisFinding[]): AnalysisFinding | undefined {
  return [...findings]
    .filter((f) => f.severity === 'negative' || f.severity === 'warning')
    .sort((a, b) => severityRank(b.severity) * b.confidence - severityRank(a.severity) * a.confidence)[0];
}

export type { StoredAnalysisSession };

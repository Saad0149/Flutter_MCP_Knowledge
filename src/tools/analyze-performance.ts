import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import { AnalysisSessionStore } from '../analysis/session/analysis-session-store.js';
import {
  toFindingCard,
  toScoreCard,
  type FindingCard,
  type ScoreCard,
} from '../analysis/session/summary-views.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';
import {
  checkAnalyzableSession,
  filterFindingsByScope,
  ScopeFilterSchema,
  withSizeMetadata,
  type Sized,
  type SizedBlockedResult,
} from './tool-response-helpers.js';

export const AnalyzePerformanceInputObjectSchema = z.object({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzePerformanceInputSchema = AnalyzePerformanceInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzePerformanceInput = z.infer<typeof AnalyzePerformanceInputObjectSchema>;

export interface AnalyzePerformanceData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly score: ScoreCard | undefined;
  readonly largeBuildMethodCount: number;
  readonly heavySetStateCount: number;
  readonly animationControllerWithoutDisposeCount: number;
  readonly constOpportunityCount: number;
  readonly findings: readonly FindingCard[];
}

@injectable()
export class AnalyzePerformanceHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzePerformanceInput,
  ): Promise<ToolResult<Sized<AnalyzePerformanceData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzePerformanceInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_performance',
          details: parsed.error.flatten(),
        });
      }

      const { session, fromCache } = await this.sessions.resolve({
        sessionId: parsed.data.sessionId,
        path: parsed.data.path,
        limit: parsed.data.limit,
      });

      const blocked = checkAnalyzableSession(session);
      if (blocked) {
        return toolOk(withSizeMetadata(blocked));
      }

      const report = session.report;
      const facts = report.results.performance.facts;
      const score = report.health.scores.find((s) => s.id === 'performance');
      const findings = filterFindingsByScope(report.results.performance.findings, parsed.data).map(
        toFindingCard,
      );

      return toolOk(
        withSizeMetadata({
          sessionId: session.sessionId,
          fromCache,
          score: score ? toScoreCard(score) : undefined,
          largeBuildMethodCount: facts.largeBuildMethodCount,
          heavySetStateCount: facts.heavySetStateCount,
          animationControllerWithoutDisposeCount: facts.animationControllerWithoutDisposeCount,
          constOpportunityCount: facts.constOpportunityCount,
          findings,
        }),
      );
    } catch (error) {
      return toolFail(error);
    }
  }
}

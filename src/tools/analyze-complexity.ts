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

export const AnalyzeComplexityInputObjectSchema = z.object({
  sessionId: z.string().min(1).max(64).optional(),
  path: z.string().min(1).max(4096).optional(),
  limit: z.number().int().positive().max(200).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzeComplexityInputSchema = AnalyzeComplexityInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzeComplexityInput = z.infer<typeof AnalyzeComplexityInputObjectSchema>;

export interface AnalyzeComplexityData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly detected: string;
  readonly score: ScoreCard | undefined;
  readonly findings: readonly FindingCard[];
}

@injectable()
export class AnalyzeComplexityHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzeComplexityInput,
  ): Promise<ToolResult<Sized<AnalyzeComplexityData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzeComplexityInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_complexity',
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
      const facts = report.results.complexity.facts;
      const score = report.health.scores.find((s) => s.id === 'complexity');
      const findings = filterFindingsByScope(report.results.complexity.findings, parsed.data).map(
        toFindingCard,
      );

      const detected =
        `avg file: ${Math.round(facts.averageFileLoc)} LOC, ` +
        `${facts.largeFileCount} files >${facts.largeFileThreshold} LOC, ` +
        `estimated high-complexity files: ${facts.estimatedHighComplexityFiles}`;

      return toolOk(
        withSizeMetadata({
          sessionId: session.sessionId,
          fromCache,
          detected,
          score: score ? toScoreCard(score) : undefined,
          findings,
        }),
      );
    } catch (error) {
      return toolFail(error);
    }
  }
}

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

export const AnalyzeTestingInputObjectSchema = z.object({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzeTestingInputSchema = AnalyzeTestingInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzeTestingInput = z.infer<typeof AnalyzeTestingInputObjectSchema>;

export interface AnalyzeTestingData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly score: ScoreCard | undefined;
  readonly testFileCount: number;
  readonly libFileCount: number;
  readonly testToLibRatio: number;
  readonly widgetTestCount: number;
  readonly integrationTestCount: number;
  readonly goldenTestCount: number;
  readonly testedFeatures: readonly string[];
  readonly untestedFeatures: readonly string[];
  readonly findings: readonly FindingCard[];
}

@injectable()
export class AnalyzeTestingHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzeTestingInput,
  ): Promise<ToolResult<Sized<AnalyzeTestingData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzeTestingInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_testing',
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
      const facts = report.results.testing.facts;
      const score = report.health.scores.find((s) => s.id === 'testing');
      const findings = filterFindingsByScope(report.results.testing.findings, parsed.data).map(
        toFindingCard,
      );

      return toolOk(
        withSizeMetadata({
          sessionId: session.sessionId,
          fromCache,
          score: score ? toScoreCard(score) : undefined,
          testFileCount: facts.testFileCount,
          libFileCount: facts.libFileCount,
          testToLibRatio: facts.testToLibRatio,
          widgetTestCount: facts.widgetTestCount,
          integrationTestCount: facts.integrationTestCount,
          goldenTestCount: facts.goldenTestCount,
          testedFeatures: facts.testedFeatures,
          untestedFeatures: facts.untestedFeatures,
          findings,
        }),
      );
    } catch (error) {
      return toolFail(error);
    }
  }
}

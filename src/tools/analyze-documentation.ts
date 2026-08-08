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

export const AnalyzeDocumentationInputObjectSchema = z.object({
  sessionId: z.string().min(1).max(64).optional(),
  path: z.string().min(1).max(4096).optional(),
  limit: z.number().int().positive().max(200).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzeDocumentationInputSchema = AnalyzeDocumentationInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzeDocumentationInput = z.infer<typeof AnalyzeDocumentationInputObjectSchema>;

export interface AnalyzeDocumentationData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly score: ScoreCard | undefined;
  readonly widgetDocumentationRatio: number;
  readonly classDocumentationRatio: number;
  readonly hasReadme: boolean;
  readonly hasAnalysisOptions: boolean;
  readonly findings: readonly FindingCard[];
}

@injectable()
export class AnalyzeDocumentationHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzeDocumentationInput,
  ): Promise<ToolResult<Sized<AnalyzeDocumentationData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzeDocumentationInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_documentation',
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
      const facts = report.results.documentation.facts;
      const score = report.health.scores.find((s) => s.id === 'documentation');
      const findings = filterFindingsByScope(report.results.documentation.findings, parsed.data).map(
        toFindingCard,
      );

      return toolOk(
        withSizeMetadata({
          sessionId: session.sessionId,
          fromCache,
          score: score ? toScoreCard(score) : undefined,
          widgetDocumentationRatio: facts.widgetDocumentationRatio,
          classDocumentationRatio: facts.classDocumentationRatio,
          hasReadme: facts.hasReadme,
          hasAnalysisOptions: facts.hasAnalysisOptions,
          findings,
        }),
      );
    } catch (error) {
      return toolFail(error);
    }
  }
}

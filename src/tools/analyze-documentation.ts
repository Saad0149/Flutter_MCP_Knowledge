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

export const AnalyzeDocumentationInputObjectSchema = z.object({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
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

  async execute(input: AnalyzeDocumentationInput): Promise<ToolResult<AnalyzeDocumentationData>> {
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

      const report = session.report;
      const facts = report.results.documentation.facts;
      const score = report.health.scores.find((s) => s.id === 'documentation');
      const findings = report.results.documentation.findings.map(toFindingCard);

      return toolOk({
        sessionId: session.sessionId,
        fromCache,
        score: score ? toScoreCard(score) : undefined,
        widgetDocumentationRatio: facts.widgetDocumentationRatio,
        classDocumentationRatio: facts.classDocumentationRatio,
        hasReadme: facts.hasReadme,
        hasAnalysisOptions: facts.hasAnalysisOptions,
        findings,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

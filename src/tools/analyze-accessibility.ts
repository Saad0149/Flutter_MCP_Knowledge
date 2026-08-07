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

export const AnalyzeAccessibilityInputObjectSchema = z.object({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzeAccessibilityInputSchema = AnalyzeAccessibilityInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzeAccessibilityInput = z.infer<typeof AnalyzeAccessibilityInputObjectSchema>;

export interface AnalyzeAccessibilityData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly score: ScoreCard | undefined;
  readonly semanticsWidgetCount: number;
  readonly tooltipUsageCount: number;
  readonly imageWithoutSemanticLabel: number;
  readonly iconButtonWithoutTooltip: number;
  readonly libFilesScanned: number;
  readonly findings: readonly FindingCard[];
}

@injectable()
export class AnalyzeAccessibilityHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzeAccessibilityInput,
  ): Promise<ToolResult<Sized<AnalyzeAccessibilityData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzeAccessibilityInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_accessibility',
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
      const facts = report.results.accessibility.facts;
      const score = report.health.scores.find((s) => s.id === 'accessibility');
      const findings = filterFindingsByScope(report.results.accessibility.findings, parsed.data).map(
        toFindingCard,
      );

      return toolOk(
        withSizeMetadata({
          sessionId: session.sessionId,
          fromCache,
          score: score ? toScoreCard(score) : undefined,
          semanticsWidgetCount: facts.semanticsWidgetCount,
          tooltipUsageCount: facts.tooltipUsageCount,
          imageWithoutSemanticLabel: facts.imageWithoutSemanticLabel,
          iconButtonWithoutTooltip: facts.iconButtonWithoutTooltip,
          libFilesScanned: facts.libFilesScanned,
          findings,
        }),
      );
    } catch (error) {
      return toolFail(error);
    }
  }
}

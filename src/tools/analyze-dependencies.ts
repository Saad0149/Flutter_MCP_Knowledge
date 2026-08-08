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
import type { LayerViolation } from '../analysis/engines/dependency-analyzer.js';
import {
  checkAnalyzableSession,
  filterFindingsByScope,
  ScopeFilterSchema,
  withSizeMetadata,
  type Sized,
  type SizedBlockedResult,
} from './tool-response-helpers.js';

export const AnalyzeDependenciesInputObjectSchema = z.object({
  sessionId: z.string().min(1).max(64).optional(),
  path: z.string().min(1).max(4096).optional(),
  limit: z.number().int().positive().max(200).optional(),
  detail: z.enum(['slim', 'full']).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzeDependenciesInputSchema = AnalyzeDependenciesInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzeDependenciesInput = z.infer<typeof AnalyzeDependenciesInputObjectSchema>;

export interface AnalyzeDependenciesSlimData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly score: ScoreCard | undefined;
  readonly totalEdges: number;
  readonly totalNodes: number;
  readonly layerViolationCount: number;
  readonly circularCycleCount: number;
  readonly findings: readonly FindingCard[];
}

export interface AnalyzeDependenciesFullData extends AnalyzeDependenciesSlimData {
  readonly layerViolations: readonly LayerViolation[];
  readonly circularCycles: readonly string[];
}

export type AnalyzeDependenciesData = AnalyzeDependenciesSlimData | AnalyzeDependenciesFullData;

@injectable()
export class AnalyzeDependenciesHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzeDependenciesInput,
  ): Promise<ToolResult<Sized<AnalyzeDependenciesData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzeDependenciesInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_dependencies',
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
      const facts = report.results.dependency.facts;
      const score = report.health.scores.find((s) => s.id === 'dependency');
      const findings = filterFindingsByScope(report.results.dependency.findings, parsed.data).map(
        toFindingCard,
      );

      const slim: AnalyzeDependenciesSlimData = {
        sessionId: session.sessionId,
        fromCache,
        score: score ? toScoreCard(score) : undefined,
        totalEdges: facts.totalEdges,
        totalNodes: facts.totalNodes,
        layerViolationCount: facts.layerViolations.length,
        circularCycleCount: facts.circularCycles.length,
        findings,
      };

      if (parsed.data.detail === 'full') {
        return toolOk(
          withSizeMetadata({
            ...slim,
            layerViolations: facts.layerViolations,
            circularCycles: facts.circularCycles,
          }),
        );
      }

      return toolOk(withSizeMetadata(slim));
    } catch (error) {
      return toolFail(error);
    }
  }
}

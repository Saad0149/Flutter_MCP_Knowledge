import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import { AnalysisSessionStore } from '../analysis/session/analysis-session-store.js';
import {
  filterFindingsByCategory,
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

export const AnalyzeCodeQualityInputObjectSchema = z.object({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzeCodeQualityInputSchema = AnalyzeCodeQualityInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzeCodeQualityInput = z.infer<typeof AnalyzeCodeQualityInputObjectSchema>;

export interface AnalyzeCodeQualityData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
  readonly narrative: string;
  readonly score: ScoreCard | undefined;
  readonly metrics: {
    readonly classCount: number;
    readonly widgetCount: number;
    readonly largeClassCandidates: number;
    readonly godClassCandidates: number;
    readonly largeBuildMethods: number;
  };
  readonly topRisks: readonly string[];
  readonly strengths: readonly string[];
  readonly findings: readonly FindingCard[];
  readonly usage: string;
}

@injectable()
export class AnalyzeCodeQualityHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzeCodeQualityInput,
  ): Promise<ToolResult<Sized<AnalyzeCodeQualityData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzeCodeQualityInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_code_quality',
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
      const findings = filterFindingsByScope(
        filterFindingsByCategory(report.findings, [
          'oop',
          'solid',
          'dart',
          'flutter',
          'data_structures',
        ]),
        parsed.data,
      );
      const facts = report.results.codeQuality.facts;
      const score = report.health.scores.find((s) => s.id === 'codeQuality');

      return toolOk(withSizeMetadata({
        sessionId: session.sessionId,
        fromCache,
        projectPath: report.projectPath,
        narrative: report.insight.codeQuality,
        score: score ? toScoreCard(score) : undefined,
        metrics: {
          classCount: facts.classCount,
          widgetCount: facts.widgetCount,
          largeClassCandidates: facts.largeClassCandidates?.length ?? 0,
          godClassCandidates: facts.godClassDetails?.length ?? facts.godClassCandidates.length,
          largeBuildMethods: facts.largeBuildMethods.length,
        },
        topRisks: findings
          .filter((f) => f.severity === 'negative' || f.severity === 'warning')
          .slice(0, 5)
          .map((f) => f.title),
        strengths: findings
          .filter((f) => f.severity === 'positive')
          .slice(0, 5)
          .map((f) => f.title),
        findings: findings.map(toFindingCard),
        usage: 'Use explore_finding with sessionId + findingCode for file-level evidence.',
      }));
    } catch (error) {
      return toolFail(error);
    }
  }
}

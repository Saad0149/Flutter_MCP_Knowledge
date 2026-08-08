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

export const AnalyzeStateManagementInputObjectSchema = z.object({
  sessionId: z.string().min(1).max(64).optional(),
  path: z.string().min(1).max(4096).optional(),
  limit: z.number().int().positive().max(200).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzeStateManagementInputSchema = AnalyzeStateManagementInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzeStateManagementInput = z.infer<typeof AnalyzeStateManagementInputObjectSchema>;

export interface AnalyzeStateManagementData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
  readonly narrative: string;
  readonly score: ScoreCard | undefined;
  readonly approaches: readonly string[];
  readonly setState: {
    readonly total: number;
    readonly local: number;
    readonly problematic: number;
  };
  readonly featuresWithMixedLibraries: readonly string[];
  readonly topRisks: readonly string[];
  readonly strengths: readonly string[];
  readonly findings: readonly FindingCard[];
  readonly usage: string;
}

@injectable()
export class AnalyzeStateManagementHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzeStateManagementInput,
  ): Promise<ToolResult<Sized<AnalyzeStateManagementData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzeStateManagementInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_state_management',
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
        filterFindingsByCategory(report.findings, ['state_management']),
        parsed.data,
      );
      const facts = report.results.stateManagement.facts;
      const score = report.health.scores.find((s) => s.id === 'stateManagement');

      return toolOk(withSizeMetadata({
        sessionId: session.sessionId,
        fromCache,
        projectPath: report.projectPath,
        narrative: report.insight.stateManagement,
        score: score ? toScoreCard(score) : undefined,
        approaches: facts.detectedApproaches,
        setState: {
          total: facts.setStateCallSites,
          local: facts.localSetStateSites ?? 0,
          problematic: facts.problematicSetStateSites ?? 0,
        },
        featuresWithMixedLibraries: facts.featuresWithMixedLibraries ?? [],
        topRisks: findings
          .filter((f) => f.severity === 'negative' || f.severity === 'warning')
          .slice(0, 5)
          .map((f) => f.title),
        strengths: findings
          .filter((f) => f.severity === 'positive')
          .slice(0, 5)
          .map((f) => f.title),
        findings: findings.map(toFindingCard),
        usage: 'Use explore_finding with sessionId + findingCode for evidence.',
      }));
    } catch (error) {
      return toolFail(error);
    }
  }
}

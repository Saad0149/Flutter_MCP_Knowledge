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

/** Object schema (MCP registration). Prefer sessionId over path. */
export const AnalyzeArchitectureInputObjectSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe('Session from review_project — preferred; skips rescanning'),
  path: z
    .string()
    .min(1)
    .optional()
    .describe('Project path — used only when sessionId is omitted (triggers analysis)'),
  limit: z.number().int().positive().max(200).optional(),
  ...ScopeFilterSchema,
});

export const AnalyzeArchitectureInputSchema = AnalyzeArchitectureInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type AnalyzeArchitectureInput = z.infer<typeof AnalyzeArchitectureInputObjectSchema>;

export interface AnalyzeArchitectureData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
  readonly narrative: string;
  readonly score: ScoreCard | undefined;
  readonly detected: string;
  readonly detectionConfidence: number;
  readonly alternatives: readonly { readonly architecture: string; readonly confidence: number }[];
  readonly dependencyDirection: string;
  readonly missingComponents: readonly string[];
  readonly topRisks: readonly string[];
  readonly strengths: readonly string[];
  readonly findings: readonly FindingCard[];
  readonly usage: string;
}

@injectable()
export class AnalyzeArchitectureHandler {
  constructor(@inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore) {}

  async execute(
    input: AnalyzeArchitectureInput,
  ): Promise<ToolResult<Sized<AnalyzeArchitectureData> | SizedBlockedResult>> {
    try {
      const parsed = AnalyzeArchitectureInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for analyze_architecture',
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
        filterFindingsByCategory(report.findings, ['architecture', 'dependency', 'testing']),
        parsed.data,
      );
      const score = report.health.scores.find((s) => s.id === 'architecture');

      return toolOk(withSizeMetadata({
        sessionId: session.sessionId,
        fromCache,
        projectPath: report.projectPath,
        narrative: report.insight.architecture,
        score: score ? toScoreCard(score) : undefined,
        detected: report.architectureDetection.detected.architecture,
        detectionConfidence: report.architectureDetection.detected.confidence,
        alternatives: report.architectureDetection.alternatives.map((a) => ({
          architecture: a.architecture,
          confidence: a.confidence,
        })),
        dependencyDirection: report.architectureDetection.dependencyDirection,
        missingComponents: report.architectureDetection.missingComponents,
        topRisks: findings
          .filter((f) => f.severity === 'negative' || f.severity === 'warning')
          .slice(0, 5)
          .map((f) => f.title),
        strengths: findings
          .filter((f) => f.severity === 'positive')
          .slice(0, 5)
          .map((f) => f.title),
        findings: findings.map(toFindingCard),
        usage: 'Use explore_finding / explain_finding with this sessionId + findingCode for evidence.',
      }));
    } catch (error) {
      return toolFail(error);
    }
  }
}

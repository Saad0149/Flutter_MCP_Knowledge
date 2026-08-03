import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { AnalysisFinding, EvidenceItem, OfficialReference } from '../analysis/index.js';
import { RecommendationEngine } from '../analysis/index.js';
import { AnalysisSessionStore } from '../analysis/session/analysis-session-store.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const ExploreFindingInputObjectSchema = z.object({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  findingCode: z.string().min(1),
  findingId: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

export const ExploreFindingInputSchema = ExploreFindingInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type ExploreFindingInput = z.infer<typeof ExploreFindingInputObjectSchema>;

export interface ExploreFindingData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
  readonly finding: Pick<
    AnalysisFinding,
    'id' | 'code' | 'title' | 'severity' | 'confidence' | 'description' | 'priority'
  >;
  readonly evidence: readonly EvidenceItem[];
  readonly affectedFiles: readonly string[];
  readonly affectedSymbols: readonly string[];
  readonly relatedFindings: readonly { readonly code: string; readonly title: string }[];
  readonly suggestedRefactoring: string;
  readonly officialReferences: readonly OfficialReference[];
  readonly confidence: number;
}

@injectable()
export class ExploreFindingHandler {
  constructor(
    @inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore,
    @inject(TYPES.RecommendationEngine) private readonly recommendations: RecommendationEngine,
  ) {}

  async execute(input: ExploreFindingInput): Promise<ToolResult<ExploreFindingData>> {
    try {
      const parsed = ExploreFindingInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for explore_finding',
          details: parsed.error.flatten(),
        });
      }

      const limit = parsed.data.limit ?? 20;
      const { session, fromCache } = await this.sessions.resolve({
        sessionId: parsed.data.sessionId,
        path: parsed.data.path,
      });

      const match =
        (parsed.data.findingId
          ? session.report.findings.find((f) => f.id === parsed.data.findingId)
          : undefined) ??
        session.report.findings.find(
          (f) => f.code.toLowerCase() === parsed.data.findingCode.toLowerCase(),
        );

      if (!match) {
        return toolFail({
          code: 'InvalidArguments',
          message: `Finding not found in session: ${parsed.data.findingCode}`,
          details: {
            availableCodes: session.report.findings.map((f) => f.code),
            sessionId: session.sessionId,
          },
        });
      }

      const evidence = (match.evidenceItems ?? []).slice(0, limit);
      const affectedFiles = [
        ...new Set(
          [match.file, ...evidence.map((e) => e.file)].filter((x): x is string => Boolean(x)),
        ),
      ].slice(0, limit);
      const affectedSymbols = [
        ...new Set(evidence.map((e) => e.symbol).filter((s): s is string => Boolean(s))),
      ].slice(0, limit);

      const relatedCodes = new Set(match.relatedFindingCodes ?? []);
      const relatedFindings = session.report.findings
        .filter((f) => relatedCodes.has(f.code) && f.code !== match.code)
        .slice(0, 8)
        .map((f) => ({ code: f.code, title: f.title }));

      const recommendation = this.recommendations.explainFinding(match, session.report.findings);

      return toolOk({
        sessionId: session.sessionId,
        fromCache,
        projectPath: session.projectPath,
        finding: {
          id: match.id,
          code: match.code,
          title: match.title,
          severity: match.severity,
          confidence: match.confidence,
          description: match.description,
          priority: match.priority,
        },
        evidence,
        affectedFiles,
        affectedSymbols,
        relatedFindings,
        suggestedRefactoring: recommendation.suggestedRefactor,
        officialReferences: recommendation.officialReferences.slice(0, 5),
        confidence: match.confidence,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

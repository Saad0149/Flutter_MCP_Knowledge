import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { FindingExplanation } from '../analysis/insight/explanation-engine.js';
import { ExplanationEngine } from '../analysis/index.js';
import { AnalysisSessionStore } from '../analysis/session/analysis-session-store.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const ExplainFindingInputObjectSchema = z.object({
  sessionId: z.string().min(1).optional().describe('Preferred — from review_project'),
  path: z.string().min(1).optional().describe('Fallback if no sessionId (rescans)'),
  findingCode: z.string().min(1).describe('Finding code e.g. PresentationImportsData'),
  findingId: z.string().optional(),
});

export const ExplainFindingInputSchema = ExplainFindingInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
);

export type ExplainFindingInput = z.infer<typeof ExplainFindingInputObjectSchema>;

export interface ExplainFindingData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
  readonly explanation: FindingExplanation;
  readonly recommendation: FindingExplanation['recommendation'];
  readonly relatedFindings: readonly { readonly code: string; readonly title: string }[];
}

@injectable()
export class ExplainFindingHandler {
  constructor(
    @inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore,
    @inject(TYPES.ExplanationEngine) private readonly explanation: ExplanationEngine,
  ) {}

  async execute(input: ExplainFindingInput): Promise<ToolResult<ExplainFindingData>> {
    try {
      const parsed = ExplainFindingInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for explain_finding',
          details: parsed.error.flatten(),
        });
      }

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
          message: `Finding code not present in session: ${parsed.data.findingCode}`,
          details: {
            availableCodes: session.report.findings.map((f) => f.code),
            sessionId: session.sessionId,
          },
        });
      }

      const explanation = this.explanation.explainFinding(match, session.report.findings);

      return toolOk({
        sessionId: session.sessionId,
        fromCache,
        projectPath: session.projectPath,
        explanation,
        recommendation: explanation.recommendation,
        relatedFindings: explanation.relatedFindings,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

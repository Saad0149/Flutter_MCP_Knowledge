import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type {
  AnalysisFinding,
  EvidenceItem,
  OfficialReference,
  RecommendationDifficulty,
  RecommendationPriority,
} from '../analysis/index.js';
import { ExplanationEngine } from '../analysis/index.js';
import type { StoredAnalysisSession } from '../analysis/session/analysis-session-store.js';
import { AnalysisSessionStore } from '../analysis/session/analysis-session-store.js';
import { TYPES } from '../types/tokens.js';
import {
  capEvidence,
  FindingResponseShapeSchema,
  omitEmpty,
  resolveShapeOptions,
  selectFields,
  summarizeCyclePaths,
  type FindingResponseShapeInput,
} from './finding-response-shape.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';
import { checkAnalyzableSession, withSizeMetadata } from './tool-response-helpers.js';

export const ExplainFindingInputObjectSchema = z.object({
  sessionId: z.string().min(1).optional().describe('Preferred — from review_project'),
  path: z.string().min(1).optional().describe('Fallback if no sessionId (rescans)'),
  findingCode: z
    .string()
    .min(1)
    .optional()
    .describe('Finding code e.g. PresentationImportsData. Omit when using codes[].'),
  findingId: z.string().optional(),
  codes: z
    .array(z.string().min(1))
    .min(1)
    .max(25)
    .optional()
    .describe(
      'Batch alternative to findingCode: explain multiple finding codes in one call. ' +
        'Returns { results: [...] } instead of a single flat result.',
    ),
  ...FindingResponseShapeSchema,
});

export const ExplainFindingInputSchema = ExplainFindingInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
).refine((v) => Boolean(v.findingCode || v.codes), {
  message: 'Provide findingCode or codes',
});

export type ExplainFindingInput = z.infer<typeof ExplainFindingInputObjectSchema>;

export interface ExplainFindingFix {
  readonly suggestedFix: string | null;
  readonly suggestedRefactor: string;
  readonly difficulty: RecommendationDifficulty;
  readonly estimatedEffort: string;
  readonly expectedImprovement: string;
  readonly expectedBenefits: readonly string[];
  readonly potentialTradeoffs: readonly string[];
}

export interface ExplainFindingResult {
  readonly findingCode: string;
  readonly summary: string;
  readonly fix: ExplainFindingFix;
  readonly evidence: readonly EvidenceItem[];
  readonly evidenceOmittedCount?: number;
  readonly cycleSummary?: string;
  readonly whyThisMatters?: string;
  readonly technicalExplanation?: string;
  readonly officialGuidance?: string;
  readonly officialReferences?: readonly OfficialReference[];
  readonly realFlutterExamples?: readonly OfficialReference[];
  readonly relatedFlutterWidgets?: readonly string[];
  readonly relatedApis?: readonly string[];
  readonly relatedFindings?: readonly { readonly code: string; readonly title: string }[];
  readonly priority: RecommendationPriority;
  readonly confidence: number;
}

export interface ExplainFindingNotFound {
  readonly findingCode: string;
  readonly status: 'not_found';
  readonly reason: 'unknown_code';
  readonly message: string;
}

export interface ExplainFindingData extends ExplainFindingResult {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
}

export interface ExplainFindingBatchData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
  readonly results: readonly (ExplainFindingResult | ExplainFindingNotFound)[];
}

/** Field sets per verbosity preset; "fields" input overrides this entirely. */
const BRIEF_FIELDS = ['summary', 'fix', 'evidence', 'evidenceOmittedCount', 'priority', 'confidence'];
const ALWAYS_KEEP = ['findingCode'];

@injectable()
export class ExplainFindingHandler {
  constructor(
    @inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore,
    @inject(TYPES.ExplanationEngine) private readonly explanation: ExplanationEngine,
  ) {}

  async execute(
    input: ExplainFindingInput,
  ): Promise<ToolResult<Partial<ExplainFindingData> | (ExplainFindingBatchData & { bytes: number; approxTokens: number })>> {
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

      const blocked = checkAnalyzableSession(session);
      if (blocked) {
        return toolOk(withSizeMetadata(blocked));
      }

      const shape = resolveShapeOptions(parsed.data as FindingResponseShapeInput);

      if (parsed.data.codes && parsed.data.codes.length > 0) {
        const results = parsed.data.codes.map((code) =>
          this.buildOne(session, code, undefined, shape),
        );
        return toolOk(
          withSizeMetadata({
            sessionId: session.sessionId,
            fromCache,
            projectPath: session.projectPath,
            results,
          }),
        );
      }

      const result = this.buildOne(session, parsed.data.findingCode!, parsed.data.findingId, shape);
      if (result.status === 'not_found') {
        return toolFail({
          code: 'InvalidArguments',
          message: result.message,
          details: {
            reason: result.reason,
            availableCodes: session.report.findings.map((f) => f.code),
            sessionId: session.sessionId,
          },
        });
      }

      return toolOk(
        withSizeMetadata({
          sessionId: session.sessionId,
          fromCache,
          projectPath: session.projectPath,
          ...result,
        }),
      );
    } catch (error) {
      return toolFail(error);
    }
  }

  /** Builds one finding's shaped response, or a not_found marker — used by
   * both the single-code path and the codes[] batch path. */
  private buildOne(
    session: StoredAnalysisSession,
    findingCode: string,
    findingId: string | undefined,
    shape: ReturnType<typeof resolveShapeOptions>,
  ): (ExplainFindingResult & { status?: undefined }) | ExplainFindingNotFound {
    const match =
      (findingId ? session.report.findings.find((f) => f.id === findingId) : undefined) ??
      session.report.findings.find((f) => f.code.toLowerCase() === findingCode.toLowerCase());

    if (!match) {
      return {
        findingCode,
        status: 'not_found',
        reason: 'unknown_code',
        message: `Finding code not present in session: ${findingCode}`,
      };
    }

    return this.buildResult(session, match, shape);
  }

  private buildResult(
    session: StoredAnalysisSession,
    match: AnalysisFinding,
    shape: ReturnType<typeof resolveShapeOptions>,
  ): ExplainFindingResult & { status?: undefined } {
    // explainFinding() internally computes explanation + recommendation, but
    // both read evidence from the same enriched finding (the Evidence Store) —
    // we take it exactly once here instead of serializing the engines' own
    // internal copies (explanation.evidence / recommendation.evidence /
    // recommendation.evidenceItems all pointed at the same underlying array).
    const explanation = this.explanation.explainFinding(match, session.report.findings);
    const rec = explanation.recommendation;
    const { evidence, evidenceOmittedCount } = capEvidence(rec.evidenceItems, shape.maxEvidence);

    const full: ExplainFindingResult = {
      findingCode: match.code,
      summary: explanation.summary,
      fix: {
        suggestedFix: rec.suggestedFix,
        suggestedRefactor: rec.suggestedRefactor,
        difficulty: rec.difficulty,
        estimatedEffort: rec.estimatedEffort,
        expectedImprovement: rec.expectedImpact,
        expectedBenefits: rec.expectedBenefits,
        potentialTradeoffs: explanation.potentialTradeoffs,
      },
      evidence,
      evidenceOmittedCount,
      cycleSummary: summarizeCyclePaths(match),
      whyThisMatters: explanation.whyThisMatters,
      technicalExplanation: explanation.technicalExplanation,
      officialGuidance: shape.includeOfficialRefs ? explanation.officialGuidance : undefined,
      officialReferences: shape.includeOfficialRefs ? explanation.officialReferences : undefined,
      realFlutterExamples: shape.includeOfficialRefs ? explanation.realFlutterExamples : undefined,
      relatedFlutterWidgets: explanation.relatedFlutterWidgets,
      relatedApis: explanation.relatedApis,
      relatedFindings: shape.includeRelated ? explanation.relatedFindings : undefined,
      priority: rec.priority,
      confidence: explanation.confidence,
    };

    const fieldsToKeep = shape.fields ?? (shape.verbosity === 'brief' ? BRIEF_FIELDS : undefined);
    const selected = selectFields(full, fieldsToKeep, ALWAYS_KEEP);
    return omitEmpty(selected) as ExplainFindingResult;
  }
}

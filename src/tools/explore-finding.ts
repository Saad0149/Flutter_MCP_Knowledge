import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { AnalysisFinding, EvidenceItem, OfficialReference } from '../analysis/index.js';
import { RecommendationEngine } from '../analysis/index.js';
import type { StoredAnalysisSession } from '../analysis/session/analysis-session-store.js';
import { AnalysisSessionStore } from '../analysis/session/analysis-session-store.js';
import { TYPES } from '../types/tokens.js';
import {
  capEvidence,
  FindingResponseShapeSchema,
  omitEmpty,
  resolveShapeOptions,
  selectFields,
  type FindingResponseShapeInput,
} from './finding-response-shape.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';
import { checkAnalyzableSession, withSizeMetadata } from './tool-response-helpers.js';

export const ExploreFindingInputObjectSchema = z.object({
  sessionId: z.string().min(1).max(64).optional(),
  path: z.string().min(1).max(4096).optional(),
  findingCode: z.string().min(1).max(200).optional().describe('Omit when using codes[].'),
  findingId: z.string().max(200).optional(),
  codes: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(25)
    .optional()
    .describe(
      'Batch alternative to findingCode: explore multiple finding codes in one call. ' +
        'Returns { results: [...] } instead of a single flat result.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Caps affectedFiles/affectedSymbols (and evidence, unless maxEvidence is set). Default 20.'),
  ...FindingResponseShapeSchema,
});

export const ExploreFindingInputSchema = ExploreFindingInputObjectSchema.refine(
  (v) => Boolean(v.sessionId || v.path),
  { message: 'Provide sessionId or path' },
).refine((v) => Boolean(v.findingCode || v.codes), {
  message: 'Provide findingCode or codes',
});

export type ExploreFindingInput = z.infer<typeof ExploreFindingInputObjectSchema>;

export interface ExploreFindingResult {
  readonly finding: Pick<
    AnalysisFinding,
    'id' | 'code' | 'title' | 'severity' | 'confidence' | 'basis' | 'description' | 'priority'
  >;
  readonly evidence: readonly EvidenceItem[];
  readonly evidenceOmittedCount?: number;
  readonly affectedFiles?: readonly string[];
  readonly affectedSymbols?: readonly string[];
  readonly relatedFindings?: readonly { readonly code: string; readonly title: string }[];
  readonly suggestedRefactoring: string;
  readonly officialReferences?: readonly OfficialReference[];
  readonly confidence: number;
}

export interface ExploreFindingNotFound {
  readonly findingCode: string;
  readonly status: 'not_found';
  readonly reason: 'unknown_code';
  readonly message: string;
}

export interface ExploreFindingData extends ExploreFindingResult {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
}

export interface ExploreFindingBatchData {
  readonly sessionId: string;
  readonly fromCache: boolean;
  readonly projectPath: string;
  readonly results: readonly (ExploreFindingResult | ExploreFindingNotFound)[];
}

const BRIEF_FIELDS = ['finding', 'evidence', 'evidenceOmittedCount', 'suggestedRefactoring', 'confidence'];
const ALWAYS_KEEP: string[] = [];

@injectable()
export class ExploreFindingHandler {
  constructor(
    @inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore,
    @inject(TYPES.RecommendationEngine) private readonly recommendations: RecommendationEngine,
  ) {}

  async execute(
    input: ExploreFindingInput,
  ): Promise<ToolResult<Partial<ExploreFindingData> | (ExploreFindingBatchData & { bytes: number; approxTokens: number })>> {
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
      const shape = resolveShapeOptions(parsed.data as FindingResponseShapeInput);
      // maxEvidence (shared with explain_finding) takes precedence over the
      // pre-existing `limit` for the evidence array specifically; `limit` keeps
      // governing affectedFiles/affectedSymbols exactly as before.
      const evidenceCap = parsed.data.maxEvidence ?? parsed.data.limit ?? shape.maxEvidence;

      const { session, fromCache } = await this.sessions.resolve({
        sessionId: parsed.data.sessionId,
        path: parsed.data.path,
      });

      const blocked = checkAnalyzableSession(session);
      if (blocked) {
        return toolOk(withSizeMetadata(blocked));
      }

      if (parsed.data.codes && parsed.data.codes.length > 0) {
        const results = parsed.data.codes.map((code) =>
          this.buildOne(session, code, undefined, shape, limit, evidenceCap),
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

      const result = this.buildOne(
        session,
        parsed.data.findingCode!,
        parsed.data.findingId,
        shape,
        limit,
        evidenceCap,
      );
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

  private buildOne(
    session: StoredAnalysisSession,
    findingCode: string,
    findingId: string | undefined,
    shape: ReturnType<typeof resolveShapeOptions>,
    limit: number,
    evidenceCap: number,
  ): (ExploreFindingResult & { status?: undefined }) | ExploreFindingNotFound {
    const match =
      (findingId ? session.report.findings.find((f) => f.id === findingId) : undefined) ??
      session.report.findings.find((f) => f.code.toLowerCase() === findingCode.toLowerCase());

    if (!match) {
      return {
        findingCode,
        status: 'not_found',
        reason: 'unknown_code',
        message: `Finding not found in session: ${findingCode}`,
      };
    }

    return this.buildResult(session, match, shape, limit, evidenceCap);
  }

  private buildResult(
    session: StoredAnalysisSession,
    match: AnalysisFinding,
    shape: ReturnType<typeof resolveShapeOptions>,
    limit: number,
    evidenceCap: number,
  ): ExploreFindingResult & { status?: undefined } {
    const { evidence, evidenceOmittedCount } = capEvidence(match.evidenceItems ?? [], evidenceCap);
    const affectedFiles = [
      ...new Set([match.file, ...evidence.map((e) => e.file)].filter((x): x is string => Boolean(x))),
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

    const full: ExploreFindingResult = {
      finding: {
        id: match.id,
        code: match.code,
        title: match.title,
        severity: match.severity,
        confidence: match.confidence,
        basis: match.basis,
        description: match.description,
        priority: match.priority,
      },
      evidence,
      evidenceOmittedCount,
      affectedFiles,
      affectedSymbols,
      relatedFindings: shape.includeRelated ? relatedFindings : undefined,
      suggestedRefactoring: recommendation.suggestedRefactor,
      officialReferences: shape.includeOfficialRefs
        ? recommendation.officialReferences.slice(0, 5)
        : undefined,
      confidence: match.confidence,
    };

    const fieldsToKeep = shape.fields ?? (shape.verbosity === 'brief' ? BRIEF_FIELDS : undefined);
    const selected = selectFields(full, fieldsToKeep, ALWAYS_KEEP);
    return omitEmpty(selected) as ExploreFindingResult;
  }
}

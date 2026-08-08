import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import {
  AnalysisSessionStore,
  type StoredAnalysisSession,
} from '../analysis/session/analysis-session-store.js';
import {
  buildReviewSummary,
  type ReviewProjectSummary,
} from '../analysis/session/summary-views.js';
import type { ProjectAnalysisReport } from '../analysis/index.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';
import {
  checkAnalyzableSession,
  withSizeMetadata,
  type Sized,
  type SizedBlockedResult,
} from './tool-response-helpers.js';

export const ReviewProjectInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe('Absolute or relative path to a Flutter/Dart project root'),
  limit: z.number().int().positive().max(300).optional(),
  detail: z
    .enum(['summary', 'full'])
    .optional()
    .describe('summary (default) = executive health + sessionId; full = legacy large payload'),
});

export type ReviewProjectInput = z.infer<typeof ReviewProjectInputSchema>;

export type ReviewProjectData =
  | ReviewProjectSummary
  | (Omit<ProjectAnalysisReport, 'snapshot'> & { readonly sessionId: string });

export type ReviewProjectResult = Sized<ReviewProjectData> | SizedBlockedResult;

@injectable()
export class ReviewProjectHandler {
  constructor(
    @inject(TYPES.AnalysisSessionStore) private readonly sessions: AnalysisSessionStore,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async execute(input: ReviewProjectInput): Promise<ToolResult<ReviewProjectResult>> {
    try {
      const parsed = ReviewProjectInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for review_project',
          details: parsed.error.flatten(),
        });
      }

      const { session } = await this.sessions.resolve({
        path: parsed.data.path,
        limit: parsed.data.limit ?? 200,
        forceRefresh: true,
      });

      this.logger.info('Project review orchestration complete', {
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        findings: session.report.findings.length,
        detail: parsed.data.detail ?? 'summary',
      });

      const blocked = checkAnalyzableSession(session);
      if (blocked) {
        return toolOk(withSizeMetadata(blocked));
      }

      if (parsed.data.detail === 'full') {
        return toolOk(
          withSizeMetadata({
            sessionId: session.sessionId,
            ...session.report,
          }),
        );
      }

      return toolOk(withSizeMetadata(buildReviewSummary(session.sessionId, session.report)));
    } catch (error) {
      return toolFail(error);
    }
  }
}

export type { StoredAnalysisSession };

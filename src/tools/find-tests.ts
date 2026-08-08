import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { KnowledgeBaseNotice, KnowledgeBaseReadinessChecker } from '../repository/knowledge-base-readiness.js';
import type { KnowledgeStore } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const FindTestsInputSchema = z.object({
  symbol: z.string().min(1).max(200).describe('Symbol name to find tests for'),
  repository: z.string().min(1).max(200).optional(),
  widgetTestsOnly: z
    .boolean()
    .optional()
    .describe('When true, only return flagged widget tests'),
  limit: z.number().int().positive().max(100).optional(),
});

export type FindTestsInput = z.infer<typeof FindTestsInputSchema>;

export interface FindTestsHit {
  readonly repository: string;
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: string;
  readonly isWidgetTest: boolean;
  readonly snippet: string;
}

export interface FindTestsData {
  readonly symbol: string;
  readonly totalMatches: number;
  readonly results: readonly FindTestsHit[];
  readonly knowledgeBase?: KnowledgeBaseNotice;
}

@injectable()
export class FindTestsHandler {
  constructor(
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.KnowledgeBaseReadinessChecker)
    private readonly readiness?: KnowledgeBaseReadinessChecker,
  ) {}

  async execute(input: FindTestsInput): Promise<ToolResult<FindTestsData>> {
    try {
      const parsed = FindTestsInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for find_tests',
          details: parsed.error.flatten(),
        });
      }

      const symbol = parsed.data.symbol.trim();
      const limit = parsed.data.limit ?? 40;
      const widgetOnly = parsed.data.widgetTestsOnly ?? false;

      const readiness = await this.readiness?.check();
      if (readiness?.state === 'building') {
        return toolOk({ symbol, totalMatches: 0, results: [], knowledgeBase: readiness.notice });
      }
      const knowledgeBase = readiness?.state === 'degraded' ? readiness.notice : undefined;

      let hits = this.store.findSymbols({
        nameContains: symbol,
        isWidgetTest: widgetOnly ? true : undefined,
        underTest: widgetOnly ? undefined : true,
        repositoryName: parsed.data.repository,
        limit,
      });

      // Prefer widget tests first when not filtering exclusively
      if (!widgetOnly) {
        const widgetHits = this.store.findSymbols({
          nameContains: symbol,
          isWidgetTest: true,
          repositoryName: parsed.data.repository,
          limit,
        });
        const seen = new Set(widgetHits.map((h) => h.symbolId));
        hits = [...widgetHits, ...hits.filter((h) => !seen.has(h.symbolId))].slice(0, limit);
      }

      return toolOk({
        symbol,
        totalMatches: hits.length,
        results: hits.map((hit) => ({
          repository: hit.repositoryName,
          file: hit.filePath,
          line: hit.line,
          name: hit.name,
          kind: hit.kind,
          isWidgetTest: hit.isWidgetTest,
          snippet: hit.docstring?.split('\n')[0] ?? `${hit.kind} ${hit.name}`,
        })),
        knowledgeBase,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { KnowledgeBaseNotice, KnowledgeBaseReadinessChecker } from '../repository/knowledge-base-readiness.js';
import type { SearchService } from '../search/search-service.js';
import type { SearchMatch } from '../search/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const SearchSourceInputSchema = z.object({
  query: z
    .string()
    .min(1, 'query is required')
    .max(500)
    .describe('Text to search for in filenames and contents'),
  repository: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional repository filter, e.g. "flutter/flutter"'),
  limit: z.number().int().positive().max(200).optional().describe('Max matches (default 50)'),
});

export type SearchSourceInput = z.infer<typeof SearchSourceInputSchema>;

export interface SearchSourceHit {
  readonly repository: string;
  readonly file: string;
  readonly line: number | null;
  readonly snippet: string;
  readonly matchType: SearchMatch['matchType'];
}

export interface SearchSourceData {
  readonly query: string;
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly results: readonly SearchSourceHit[];
  readonly knowledgeBase?: KnowledgeBaseNotice;
}

@injectable()
export class SearchSourceHandler {
  constructor(
    @inject(TYPES.SearchService) private readonly searchService: SearchService,
    @inject(TYPES.KnowledgeBaseReadinessChecker)
    private readonly readiness?: KnowledgeBaseReadinessChecker,
  ) {}

  async execute(input: SearchSourceInput): Promise<ToolResult<SearchSourceData>> {
    try {
      const parsed = SearchSourceInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for search_source',
          details: parsed.error.flatten(),
        });
      }

      const readiness = await this.readiness?.check();
      if (readiness?.state === 'building') {
        return toolOk({
          query: parsed.data.query,
          totalMatches: 0,
          truncated: false,
          results: [],
          knowledgeBase: readiness.notice,
        });
      }
      const knowledgeBase = readiness?.state === 'degraded' ? readiness.notice : undefined;

      const response = await this.searchService.search({
        query: parsed.data.query,
        repository: parsed.data.repository,
        limit: parsed.data.limit,
      });

      return toolOk({
        query: response.query,
        totalMatches: response.totalMatches,
        truncated: response.truncated,
        results: response.matches.map((match) => ({
          repository: match.repository,
          file: match.file,
          line: match.line,
          snippet: match.snippet,
          matchType: match.matchType,
        })),
        knowledgeBase,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { DocKind, KnowledgeStore } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

const DocKindSchema = z.enum(['changelog', 'migration', 'guide', 'cookbook', 'general']);

export const SearchDocsInputSchema = z.object({
  query: z.string().min(1).describe('Text to search in indexed markdown docs'),
  repository: z.string().min(1).optional(),
  docKind: DocKindSchema.optional().describe('Optional doc kind filter'),
  limit: z.number().int().positive().max(100).optional(),
});

export type SearchDocsInput = z.infer<typeof SearchDocsInputSchema>;

export interface SearchDocsHit {
  readonly repository: string;
  readonly file: string;
  readonly title: string | null;
  readonly line: number;
  readonly docKind: DocKind;
  readonly snippet: string;
}

export interface SearchDocsData {
  readonly query: string;
  readonly totalMatches: number;
  readonly results: readonly SearchDocsHit[];
}

@injectable()
export class SearchDocsHandler {
  constructor(@inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore) {}

  async execute(input: SearchDocsInput): Promise<ToolResult<SearchDocsData>> {
    try {
      const parsed = SearchDocsInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for search_docs',
          details: parsed.error.flatten(),
        });
      }

      const hits = this.store.findDocs({
        query: parsed.data.query,
        repositoryName: parsed.data.repository,
        docKind: parsed.data.docKind,
        limit: parsed.data.limit ?? 30,
      });

      return toolOk({
        query: parsed.data.query,
        totalMatches: hits.length,
        results: hits.map((hit) => ({
          repository: hit.repositoryName,
          file: hit.filePath,
          title: hit.title,
          line: hit.lineStart,
          docKind: hit.docKind,
          snippet: hit.chunk.slice(0, 280),
        })),
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

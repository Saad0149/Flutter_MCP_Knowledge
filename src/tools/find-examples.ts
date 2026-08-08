import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { KnowledgeBaseNotice, KnowledgeBaseReadinessChecker } from '../repository/knowledge-base-readiness.js';
import type { KnowledgeStore } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const FindExamplesInputSchema = z.object({
  topic: z.string().min(1).max(200).describe('Topic or symbol to find examples for'),
  limit: z.number().int().positive().max(100).optional(),
});

export type FindExamplesInput = z.infer<typeof FindExamplesInputSchema>;

export interface FindExamplesHit {
  readonly repository: string;
  readonly file: string;
  readonly line: number | null;
  readonly name: string | null;
  readonly snippet: string;
  readonly kind: 'symbol' | 'doc';
}

export interface FindExamplesData {
  readonly topic: string;
  readonly totalMatches: number;
  readonly results: readonly FindExamplesHit[];
  readonly knowledgeBase?: KnowledgeBaseNotice;
}

@injectable()
export class FindExamplesHandler {
  constructor(
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.KnowledgeBaseReadinessChecker)
    private readonly readiness?: KnowledgeBaseReadinessChecker,
  ) {}

  async execute(input: FindExamplesInput): Promise<ToolResult<FindExamplesData>> {
    try {
      const parsed = FindExamplesInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for find_examples',
          details: parsed.error.flatten(),
        });
      }

      const topic = parsed.data.topic.trim();
      const limit = parsed.data.limit ?? 30;

      const readiness = await this.readiness?.check();
      if (readiness?.state === 'building') {
        return toolOk({ topic, totalMatches: 0, results: [], knowledgeBase: readiness.notice });
      }
      const knowledgeBase = readiness?.state === 'degraded' ? readiness.notice : undefined;

      const results: FindExamplesHit[] = [];

      const symbols = this.store.findSymbols({
        nameContains: topic,
        underExample: true,
        limit,
      });

      for (const hit of symbols) {
        results.push({
          repository: hit.repositoryName,
          file: hit.filePath,
          line: hit.line,
          name: hit.name,
          snippet: hit.docstring?.split('\n')[0] ?? `${hit.kind} ${hit.name}`,
          kind: 'symbol',
        });
      }

      if (results.length < limit) {
        const docs = this.store.findDocs({
          query: topic,
          repositoryName: 'flutter/samples',
          limit: limit - results.length,
        });
        for (const doc of docs) {
          results.push({
            repository: doc.repositoryName,
            file: doc.filePath,
            line: doc.lineStart,
            name: doc.title,
            snippet: doc.chunk.slice(0, 200),
            kind: 'doc',
          });
        }
      }

      // Also search example/ paths via docs in other repos
      if (results.length < limit) {
        const moreDocs = this.store.findDocs({
          query: topic,
          limit: (limit - results.length) * 2,
        });
        for (const doc of moreDocs) {
          if (!doc.filePath.includes('example')) {
            continue;
          }
          if (results.some((r) => r.file === doc.filePath && r.line === doc.lineStart)) {
            continue;
          }
          results.push({
            repository: doc.repositoryName,
            file: doc.filePath,
            line: doc.lineStart,
            name: doc.title,
            snippet: doc.chunk.slice(0, 200),
            kind: 'doc',
          });
          if (results.length >= limit) {
            break;
          }
        }
      }

      return toolOk({
        topic,
        totalMatches: results.length,
        results: results.slice(0, limit),
        knowledgeBase,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

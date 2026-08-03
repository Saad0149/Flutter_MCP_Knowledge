import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { Indexer, IndexRunResult } from '../indexer/repository-indexer.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const ReindexInputSchema = z.object({
  repository: z
    .string()
    .min(1)
    .optional()
    .describe('Optional repository to reindex; omit to reindex all'),
  force: z
    .boolean()
    .optional()
    .describe('When true, re-extract all files even if hashes match'),
});

export type ReindexInput = z.infer<typeof ReindexInputSchema>;

export interface ReindexData {
  readonly result: IndexRunResult;
}

@injectable()
export class ReindexHandler {
  constructor(@inject(TYPES.Indexer) private readonly indexer: Indexer) {}

  async execute(input: ReindexInput = {}): Promise<ToolResult<ReindexData>> {
    try {
      const parsed = ReindexInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for reindex',
          details: parsed.error.flatten(),
        });
      }

      const force = parsed.data.force ?? false;

      if (parsed.data.repository) {
        const single = await this.indexer.indexRepository(parsed.data.repository, { force });
        return toolOk({
          result: {
            mode: force ? 'full' : 'incremental',
            repositories: [single],
            durationMs: single.durationMs,
          },
        });
      }

      const result = await this.indexer.indexAll({ force });
      return toolOk({ result });
    } catch (error) {
      return toolFail(error);
    }
  }
}

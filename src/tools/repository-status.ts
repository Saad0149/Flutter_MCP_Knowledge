import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { RepositoryManager, RepositoryStatus } from '../repository/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const RepositoryStatusInputSchema = z.object({
  repository: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional repository name, e.g. "flutter/flutter"'),
});

export type RepositoryStatusInput = z.infer<typeof RepositoryStatusInputSchema>;

export interface RepositoryStatusData {
  readonly repositories: readonly RepositoryStatus[];
}

@injectable()
export class RepositoryStatusHandler {
  constructor(
    @inject(TYPES.RepositoryManager) private readonly repositories: RepositoryManager,
  ) {}

  async execute(input: RepositoryStatusInput = {}): Promise<ToolResult<RepositoryStatusData>> {
    try {
      const parsed = RepositoryStatusInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for repository_status',
          details: parsed.error.flatten(),
        });
      }

      const repositories = await this.repositories.getStatus(parsed.data.repository);
      return toolOk({ repositories });
    } catch (error) {
      return toolFail(error);
    }
  }
}

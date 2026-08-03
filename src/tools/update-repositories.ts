import { inject, injectable } from 'tsyringe';
import type { AppConfig } from '../config/schema.js';
import type { Indexer, RepositoryIndexResult } from '../indexer/repository-indexer.js';
import type { RepositoryManager, UpdateResult } from '../repository/types.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export interface UpdateRepositoriesData {
  readonly repositories: readonly UpdateResult[];
  readonly index?: {
    readonly ran: boolean;
    readonly repositories: readonly RepositoryIndexResult[];
  };
}

@injectable()
export class UpdateRepositoriesHandler {
  constructor(
    @inject(TYPES.RepositoryManager) private readonly repositories: RepositoryManager,
    @inject(TYPES.Indexer) private readonly indexer: Indexer,
    @inject(TYPES.Config) private readonly config: AppConfig,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async execute(): Promise<ToolResult<UpdateRepositoriesData>> {
    try {
      const results = await this.repositories.updateAll();

      if (!this.config.indexOnUpdate) {
        return toolOk({ repositories: results, index: { ran: false, repositories: [] } });
      }

      const indexResults: RepositoryIndexResult[] = [];
      for (const result of results) {
        if (result.status === 'error') {
          continue;
        }
        try {
          indexResults.push(await this.indexer.indexRepository(result.name));
        } catch (error) {
          this.logger.error('Post-update index failed', {
            repository: result.name,
            error: error instanceof Error ? error.message : error,
          });
          indexResults.push({
            repository: result.name,
            status: 'error',
            filesScanned: 0,
            filesUpdated: 0,
            filesRemoved: 0,
            symbolsIndexed: 0,
            docsIndexed: 0,
            durationMs: 0,
            error: {
              code: 'IndexError',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }

      return toolOk({
        repositories: results,
        index: { ran: true, repositories: indexResults },
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

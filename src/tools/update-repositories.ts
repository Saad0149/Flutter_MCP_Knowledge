import { inject, injectable } from 'tsyringe';
import type { QueuedRepoStatus, RepositoryManager } from '../repository/types.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export interface UpdateRepositoriesData {
  /**
   * Per-repo dispatch status. 'queued' = clone/pull just started in the
   * background. 'in_progress' = a clone/pull was already running; skipped.
   * Poll repository_status to observe completion.
   */
  readonly repositories: readonly QueuedRepoStatus[];
  readonly note: string;
}

@injectable()
export class UpdateRepositoriesHandler {
  constructor(
    @inject(TYPES.RepositoryManager) private readonly repositories: RepositoryManager,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  execute(): ToolResult<UpdateRepositoriesData> {
    try {
      const queued = this.repositories.startBackgroundUpdate();

      this.logger.info('Background repository update dispatched', {
        total: queued.length,
        queued: queued.filter((r) => r.status === 'queued').length,
        inProgress: queued.filter((r) => r.status === 'in_progress').length,
      });

      return toolOk({
        repositories: queued,
        note: 'Clone/pull started in background. Call repository_status to observe progress. Indexing is not triggered automatically — call reindex after clones complete.',
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

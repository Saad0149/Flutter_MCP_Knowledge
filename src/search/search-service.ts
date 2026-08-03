import { inject, injectable } from 'tsyringe';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { AppError } from '../utils/errors.js';
import type { SearchEngine, SearchQuery, SearchResponse } from './types.js';

/**
 * Application-facing search API.
 * Delegates to the injected SearchEngine so Phase 2+ can replace
 * the filesystem implementation without changing tool handlers.
 */
@injectable()
export class SearchService {
  constructor(
    @inject(TYPES.SearchEngine) private readonly engine: SearchEngine,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async search(query: SearchQuery): Promise<SearchResponse> {
    try {
      return await this.engine.search(query);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      this.logger.error('Search failed', {
        query: query.query,
        error: error instanceof Error ? error.message : error,
      });

      throw new AppError(
        'SearchFailed',
        `Search failed for query "${query.query}"`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

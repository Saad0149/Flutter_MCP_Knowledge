import path from 'node:path';
import { inject, injectable } from 'tsyringe';
import type { KnowledgeStore } from '../store/types.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { AppError } from '../utils/errors.js';
import type { SearchEngine, SearchMatch, SearchQuery, SearchResponse } from './types.js';

const DEFAULT_LIMIT = 50;

/**
 * Prefers SQLite symbol index for name-like queries; falls back to filesystem search.
 */
@injectable()
export class IndexedSearchEngine implements SearchEngine {
  constructor(
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.FilesystemSearchEngine) private readonly filesystem: SearchEngine,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async search(query: SearchQuery): Promise<SearchResponse> {
    const trimmed = query.query.trim();
    if (!trimmed) {
      throw new AppError('InvalidArguments', 'Search query must not be empty');
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const stats = this.store.getStats();

    if (stats.symbolCount === 0 && stats.docCount === 0) {
      this.logger.info('Index empty; falling back to filesystem search', { query: trimmed });
      return this.filesystem.search(query);
    }

    const preferIndex =
      (query.searchContents ?? true) &&
      looksLikeSymbolQuery(trimmed) &&
      !(query.searchFilenames === true && query.searchContents === false);

    if (!preferIndex) {
      return this.filesystem.search(query);
    }

    try {
      const symbolHits = this.store.findSymbols({
        nameContains: stripClassPrefix(trimmed),
        repositoryName: query.repository,
        limit,
      });

      if (symbolHits.length === 0) {
        return this.filesystem.search(query);
      }

      const matches: SearchMatch[] = symbolHits.map((hit) => ({
        repository: hit.repositoryName,
        file: hit.filePath,
        absolutePath: path.join(hit.repositoryPath, hit.filePath),
        line: hit.line,
        snippet: formatSymbolSnippet(hit),
        matchType: 'content' as const,
      }));

      return {
        query: trimmed,
        totalMatches: matches.length,
        truncated: matches.length >= limit,
        matches,
      };
    } catch (error) {
      this.logger.warning('Indexed search failed; falling back to filesystem', {
        query: trimmed,
        error: error instanceof Error ? error.message : error,
      });
      return this.filesystem.search(query);
    }
  }
}

function looksLikeSymbolQuery(query: string): boolean {
  if (query.length > 80) {
    return false;
  }
  if (/\s{2,}|\n/.test(query)) {
    return false;
  }
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(stripClassPrefix(query)) || query.startsWith('class ');
}

function stripClassPrefix(query: string): string {
  return query.replace(/^class\s+/i, '').trim();
}

function formatSymbolSnippet(hit: {
  readonly kind: string;
  readonly name: string;
  readonly extendsClause: string | null;
  readonly docstring: string | null;
}): string {
  const extendsPart = hit.extendsClause ? ` extends ${hit.extendsClause}` : '';
  const header = `${hit.kind} ${hit.name}${extendsPart}`;
  if (hit.docstring) {
    const first = hit.docstring.split('\n')[0] ?? '';
    return `${header} — ${first}`.slice(0, 200);
  }
  return header.slice(0, 200);
}

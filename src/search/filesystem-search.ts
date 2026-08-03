import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fg from 'fast-glob';
import { inject, injectable } from 'tsyringe';
import type { RepositoryManager } from '../repository/types.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { AppError } from '../utils/errors.js';
import type { SearchEngine, SearchMatch, SearchQuery, SearchResponse } from './types.js';

const DEFAULT_INCLUDE = [
  '**/*.{dart,md,yaml,yml,json,txt,gn,gni,cc,h,mm,m,java,kt,swift}',
] as const;

const DEFAULT_LIMIT = 50;

const IGNORE_PATTERNS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.dart_tool/**',
  '**/build/**',
  '**/.idea/**',
  '**/out/**',
  '**/.flutter-knowledge-meta.json',
] as const;

@injectable()
export class FilesystemSearchEngine implements SearchEngine {
  constructor(
    @inject(TYPES.RepositoryManager) private readonly repositories: RepositoryManager,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async search(query: SearchQuery): Promise<SearchResponse> {
    const trimmed = query.query.trim();
    if (!trimmed) {
      throw new AppError('InvalidArguments', 'Search query must not be empty');
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const include = query.include ?? DEFAULT_INCLUDE;
    const caseSensitive = query.caseSensitive ?? false;
    const searchFilenames = query.searchFilenames ?? true;
    const searchContents = query.searchContents ?? true;

    const targets = this.resolveTargets(query.repository);
    const matches: SearchMatch[] = [];
    let truncated = false;

    this.logger.info('Starting filesystem search', {
      query: trimmed,
      repositories: targets.map((t) => t.name),
      limit,
    });

    for (const target of targets) {
      if (matches.length >= limit) {
        truncated = true;
        break;
      }

      const status = (await this.repositories.getStatus(target.name))[0];
      if (!status?.exists) {
        this.logger.warning('Skipping missing repository during search', {
          repository: target.name,
        });
        continue;
      }

      const files = await fg([...include], {
        cwd: status.path,
        absolute: true,
        onlyFiles: true,
        dot: false,
        ignore: [...IGNORE_PATTERNS],
        followSymbolicLinks: false,
      });

      for (const absolutePath of files) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }

        const relative = path.relative(status.path, absolutePath);

        if (searchFilenames && this.filenameMatches(relative, trimmed, caseSensitive)) {
          matches.push({
            repository: target.name,
            file: relative,
            absolutePath,
            line: null,
            snippet: path.basename(relative),
            matchType: 'filename',
          });

          if (matches.length >= limit) {
            truncated = true;
            break;
          }
        }

        if (searchContents) {
          const contentMatches = await this.searchFileContents(
            absolutePath,
            relative,
            target.name,
            trimmed,
            caseSensitive,
            limit - matches.length,
          );

          matches.push(...contentMatches);

          if (matches.length >= limit) {
            truncated = contentMatches.length > 0 || truncated;
            // May have more in remaining files; mark truncated conservatively
            truncated = true;
            break;
          }
        }
      }
    }

    return {
      query: trimmed,
      totalMatches: matches.length,
      truncated,
      matches,
    };
  }

  private resolveTargets(repository?: string) {
    if (!repository) {
      return this.repositories.listDefinitions();
    }

    return [this.repositories.resolveDefinition(repository)];
  }

  private filenameMatches(relativePath: string, query: string, caseSensitive: boolean): boolean {
    const haystack = caseSensitive ? relativePath : relativePath.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    return haystack.includes(needle);
  }

  private async searchFileContents(
    absolutePath: string,
    relativePath: string,
    repository: string,
    query: string,
    caseSensitive: boolean,
    remaining: number,
  ): Promise<SearchMatch[]> {
    if (remaining <= 0) {
      return [];
    }

    const matches: SearchMatch[] = [];
    const needle = caseSensitive ? query : query.toLowerCase();

    const stream = createReadStream(absolutePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineNumber = 0;

    try {
      for await (const line of rl) {
        lineNumber += 1;
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(needle)) {
          continue;
        }

        matches.push({
          repository,
          file: relativePath,
          absolutePath,
          line: lineNumber,
          snippet: this.truncateSnippet(line.trim()),
          matchType: 'content',
        });

        if (matches.length >= remaining) {
          break;
        }
      }
    } catch (error) {
      this.logger.warning('Failed to read file during search', {
        file: absolutePath,
        error: error instanceof Error ? error.message : error,
      });
    } finally {
      rl.close();
      stream.destroy();
    }

    return matches;
  }

  private truncateSnippet(value: string, max = 200): string {
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, max - 1)}…`;
  }
}

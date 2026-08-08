import path from 'node:path';
import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { KnowledgeBaseNotice, KnowledgeBaseReadinessChecker } from '../repository/knowledge-base-readiness.js';
import type { SearchService } from '../search/search-service.js';
import type { SearchMatch } from '../search/types.js';
import type { KnowledgeStore, SymbolSearchHit } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const FindWidgetInputSchema = z.object({
  name: z
    .string()
    .min(1, 'Widget name is required')
    .max(200)
    .describe('Widget class name, e.g. "AnimatedContainer"'),
  repository: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional repository filter (defaults to flutter/flutter)'),
  limit: z.number().int().positive().max(100).optional(),
});

export type FindWidgetInput = z.infer<typeof FindWidgetInputSchema>;

export interface WidgetLocation {
  readonly repository: string;
  readonly file: string;
  readonly line: number | null;
  readonly snippet: string;
}

export interface FindWidgetData {
  readonly widget: string;
  readonly file: string | null;
  readonly package: string | null;
  readonly description: string | null;
  readonly source: 'index' | 'filesystem';
  readonly locations: readonly WidgetLocation[];
  readonly knowledgeBase?: KnowledgeBaseNotice;
}

@injectable()
export class FindWidgetHandler {
  constructor(
    @inject(TYPES.SearchService) private readonly searchService: SearchService,
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.KnowledgeBaseReadinessChecker)
    private readonly readiness?: KnowledgeBaseReadinessChecker,
  ) {}

  async execute(input: FindWidgetInput): Promise<ToolResult<FindWidgetData>> {
    try {
      const parsed = FindWidgetInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for find_widget',
          details: parsed.error.flatten(),
        });
      }

      const widgetName = parsed.data.name.trim();
      const repository = parsed.data.repository ?? 'flutter/flutter';
      const limit = parsed.data.limit ?? 40;

      const readiness = await this.readiness?.check();
      if (readiness?.state === 'building') {
        return toolOk({
          widget: widgetName,
          file: null,
          package: null,
          description: null,
          source: 'index',
          locations: [],
          knowledgeBase: readiness.notice,
        });
      }
      const knowledgeBase = readiness?.state === 'degraded' ? readiness.notice : undefined;

      const indexed = this.tryIndex(widgetName, repository, limit);
      if (indexed) {
        return toolOk({ ...indexed, knowledgeBase });
      }

      return toolOk({ ...(await this.fallbackSearch(widgetName, repository, limit)), knowledgeBase });
    } catch (error) {
      return toolFail(error);
    }
  }

  private tryIndex(
    widgetName: string,
    repository: string,
    limit: number,
  ): FindWidgetData | null {
    const stats = this.store.getStats();
    if (stats.symbolCount === 0) {
      return null;
    }

    let hits = this.store.findSymbols({
      name: widgetName,
      isWidget: true,
      repositoryName: repository,
      limit,
    });

    if (hits.length === 0) {
      hits = this.store.findSymbols({
        name: widgetName,
        repositoryName: repository,
        limit,
      });
    }

    if (hits.length === 0) {
      return null;
    }

    const primary = pickPrimarySymbol(hits);
    return {
      widget: widgetName,
      file: primary?.filePath ?? null,
      package: primary?.packageName ?? null,
      description: primary
        ? primary.docstring?.split('\n')[0] ??
          `Indexed ${primary.kind} ${widgetName}${primary.extendsClause ? ` extends ${primary.extendsClause}` : ''}`
        : null,
      source: 'index',
      locations: hits.map((hit) => ({
        repository: hit.repositoryName,
        file: hit.filePath,
        line: hit.line,
        snippet: formatHit(hit),
      })),
    };
  }

  private async fallbackSearch(
    widgetName: string,
    repository: string,
    limit: number,
  ): Promise<FindWidgetData> {
    const classQuery = `class ${widgetName}`;
    let response = await this.searchService.search({
      query: classQuery,
      repository,
      limit,
      searchFilenames: false,
      searchContents: true,
      include: ['**/*.dart'],
    });

    if (response.matches.length === 0) {
      response = await this.searchService.search({
        query: widgetName,
        repository,
        limit,
        include: ['**/*.dart'],
      });
    }

    const locations = response.matches.map((match) => this.toLocation(match));
    const primary = this.pickPrimaryMatch(response.matches, widgetName);

    return {
      widget: widgetName,
      file: primary?.file ?? null,
      package: primary ? this.inferPackage(primary.file) : null,
      description: primary ? this.inferDescription(primary.snippet, widgetName) : null,
      source: 'filesystem',
      locations,
    };
  }

  private toLocation(match: SearchMatch): WidgetLocation {
    return {
      repository: match.repository,
      file: match.file,
      line: match.line,
      snippet: match.snippet,
    };
  }

  private pickPrimaryMatch(
    matches: readonly SearchMatch[],
    widgetName: string,
  ): SearchMatch | undefined {
    const classDecl = matches.find(
      (m) =>
        m.matchType === 'content' &&
        m.snippet.includes(`class ${widgetName}`) &&
        !m.file.includes('/test/') &&
        !m.file.includes('_test.dart'),
    );

    if (classDecl) {
      return classDecl;
    }

    const nonTest = matches.find(
      (m) => !m.file.includes('/test/') && !m.file.includes('_test.dart'),
    );

    return nonTest ?? matches[0];
  }

  private inferPackage(file: string): string | null {
    const normalized = file.replaceAll('\\', '/');
    const packagesIdx = normalized.indexOf('packages/');
    if (packagesIdx >= 0) {
      const rest = normalized.slice(packagesIdx + 'packages/'.length);
      const pkg = rest.split('/')[0];
      return pkg || null;
    }

    if (normalized.startsWith('lib/')) {
      return 'flutter';
    }

    return path.basename(path.dirname(normalized)) || null;
  }

  private inferDescription(snippet: string, widgetName: string): string | null {
    const cleaned = snippet.replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      return null;
    }

    if (cleaned.includes(`class ${widgetName}`)) {
      return `Declaration match for ${widgetName} (filesystem fallback).`;
    }

    return `Reference match for ${widgetName} (filesystem fallback).`;
  }
}

function pickPrimarySymbol(hits: readonly SymbolSearchHit[]): SymbolSearchHit | undefined {
  return (
    hits.find(
      (h) =>
        h.isWidget &&
        !h.filePath.includes('/test/') &&
        !h.filePath.includes('_test.dart'),
    ) ??
    hits.find((h) => !h.filePath.includes('/test/')) ??
    hits[0]
  );
}

function formatHit(hit: SymbolSearchHit): string {
  const extendsPart = hit.extendsClause ? ` extends ${hit.extendsClause}` : '';
  return `${hit.kind} ${hit.name}${extendsPart}`;
}

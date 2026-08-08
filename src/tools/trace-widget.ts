import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { KnowledgeBaseNotice, KnowledgeBaseReadinessChecker } from '../repository/knowledge-base-readiness.js';
import type { KnowledgeStore, SymbolSearchHit } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const TraceWidgetInputSchema = z.object({
  symbol: z.string().min(1).max(200).describe('Widget or class name to trace'),
  repository: z.string().min(1).max(200).optional(),
  depth: z.number().int().positive().max(5).optional(),
});

export type TraceWidgetInput = z.infer<typeof TraceWidgetInputSchema>;

export interface TraceNode {
  readonly name: string;
  readonly kind: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly repository: string | null;
  readonly extendsClause: string | null;
  readonly withClause: string | null;
  readonly implementsClause: string | null;
  readonly parents: readonly TraceNode[];
}

export interface TraceWidgetData {
  readonly symbol: string;
  readonly found: boolean;
  readonly tree: TraceNode | null;
  readonly related: readonly {
    readonly name: string;
    readonly relationship: string;
    readonly file: string;
    readonly repository: string;
  }[];
  readonly knowledgeBase?: KnowledgeBaseNotice;
}

@injectable()
export class TraceWidgetHandler {
  constructor(
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.KnowledgeBaseReadinessChecker)
    private readonly readiness?: KnowledgeBaseReadinessChecker,
  ) {}

  async execute(input: TraceWidgetInput): Promise<ToolResult<TraceWidgetData>> {
    try {
      const parsed = TraceWidgetInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for trace_widget',
          details: parsed.error.flatten(),
        });
      }

      const symbol = parsed.data.symbol.trim();
      const repository = parsed.data.repository ?? 'flutter/flutter';
      const depth = parsed.data.depth ?? 3;

      const readiness = await this.readiness?.check();
      if (readiness?.state === 'building') {
        return toolOk({ symbol, found: false, tree: null, related: [], knowledgeBase: readiness.notice });
      }
      const knowledgeBase = readiness?.state === 'degraded' ? readiness.notice : undefined;

      const root =
        this.store.getSymbolByName(symbol, { repositoryName: repository }) ??
        this.store.getSymbolByName(symbol);

      if (!root) {
        return toolOk({
          symbol,
          found: false,
          tree: null,
          related: [],
          knowledgeBase,
        });
      }

      const tree = this.buildTree(root, depth, new Set([root.name]));
      const related = this.findRelated(root, repository);

      return toolOk({
        symbol,
        found: true,
        tree,
        related,
        knowledgeBase,
      });
    } catch (error) {
      return toolFail(error);
    }
  }

  private buildTree(
    hit: SymbolSearchHit,
    depth: number,
    visited: Set<string>,
  ): TraceNode {
    const parentNames = [
      ...splitTypes(hit.extendsClause),
      ...splitTypes(hit.withClause),
      ...splitTypes(hit.implementsClause),
    ];

    const parents: TraceNode[] = [];
    if (depth > 0) {
      for (const parentName of parentNames) {
        if (visited.has(parentName)) {
          continue;
        }
        visited.add(parentName);
        const parent =
          this.store.getSymbolByName(parentName, { repositoryName: hit.repositoryName }) ??
          this.store.getSymbolByName(parentName);
        if (parent) {
          parents.push(this.buildTree(parent, depth - 1, visited));
        } else {
          parents.push({
            name: parentName,
            kind: 'unknown',
            file: null,
            line: null,
            repository: null,
            extendsClause: null,
            withClause: null,
            implementsClause: null,
            parents: [],
          });
        }
      }
    }

    return {
      name: hit.name,
      kind: hit.kind,
      file: hit.filePath,
      line: hit.line,
      repository: hit.repositoryName,
      extendsClause: hit.extendsClause,
      withClause: hit.withClause,
      implementsClause: hit.implementsClause,
      parents,
    };
  }

  private findRelated(root: SymbolSearchHit, repository: string) {
    const related: Array<{
      name: string;
      relationship: string;
      file: string;
      repository: string;
    }> = [];
    const parentNames = new Set([
      ...splitTypes(root.extendsClause),
      ...splitTypes(root.withClause),
      ...splitTypes(root.implementsClause),
    ]);

    for (const parentName of parentNames) {
      const parent =
        this.store.getSymbolByName(parentName, { repositoryName: repository }) ??
        this.store.getSymbolByName(parentName);
      if (parent) {
        related.push({
          name: parent.name,
          relationship: 'parent',
          file: parent.filePath,
          repository: parent.repositoryName,
        });
      }
    }

    const candidates = this.store.findSymbols({
      repositoryName: repository,
      kind: 'class',
      limit: 200,
    });

    for (const candidate of candidates) {
      if (candidate.name === root.name) {
        continue;
      }
      const extendsTypes = splitTypes(candidate.extendsClause);
      if (extendsTypes.includes(root.name)) {
        related.push({
          name: candidate.name,
          relationship: 'child',
          file: candidate.filePath,
          repository: candidate.repositoryName,
        });
      }
      if (related.length >= 40) {
        break;
      }
    }

    return related;
  }
}
function splitTypes(clause: string | null): string[] {
  if (!clause) {
    return [];
  }
  return clause
    .split(',')
    .map((part) => part.trim().split('<')[0]?.trim())
    .filter((name): name is string => Boolean(name));
}

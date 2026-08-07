import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { KnowledgeBaseNotice, KnowledgeBaseReadinessChecker } from '../repository/knowledge-base-readiness.js';
import type { KnowledgeStore } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const FindBestPracticeInputSchema = z.object({
  topic: z.string().min(1).describe('Best-practice topic, e.g. "keys" or "const constructors"'),
  limit: z.number().int().positive().max(50).optional(),
});

export type FindBestPracticeInput = z.infer<typeof FindBestPracticeInputSchema>;

export interface BestPracticeHit {
  readonly score: number;
  readonly repository: string;
  readonly file: string;
  readonly title: string | null;
  readonly line: number | null;
  readonly snippet: string;
  readonly source: 'website' | 'samples' | 'docs' | 'symbol' | 'migration' | 'changelog' | 'cookbook';
  readonly docKind?: string;
}

export interface FindBestPracticeData {
  readonly topic: string;
  readonly results: readonly BestPracticeHit[];
  readonly knowledgeBase?: KnowledgeBaseNotice;
}

@injectable()
export class FindBestPracticeHandler {
  constructor(
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.KnowledgeBaseReadinessChecker)
    private readonly readiness?: KnowledgeBaseReadinessChecker,
  ) {}

  async execute(input: FindBestPracticeInput): Promise<ToolResult<FindBestPracticeData>> {
    try {
      const parsed = FindBestPracticeInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for find_best_practice',
          details: parsed.error.flatten(),
        });
      }

      const topic = parsed.data.topic.trim();
      const limit = parsed.data.limit ?? 20;

      const readiness = await this.readiness?.check();
      if (readiness?.state === 'building') {
        return toolOk({ topic, results: [], knowledgeBase: readiness.notice });
      }
      const knowledgeBase = readiness?.state === 'degraded' ? readiness.notice : undefined;

      const hits: BestPracticeHit[] = [];

      const prioritized = this.store.findDocs({
        query: topic,
        docKinds: ['migration', 'cookbook', 'changelog', 'guide'],
        limit: limit * 2,
      });
      for (const doc of prioritized) {
        hits.push({
          score: scoreDoc(doc.filePath, doc.title, doc.docKind, doc.repositoryName),
          repository: doc.repositoryName,
          file: doc.filePath,
          title: doc.title,
          line: doc.lineStart,
          snippet: doc.chunk.slice(0, 240),
          source: sourceFromKind(doc.docKind, doc.repositoryName),
          docKind: doc.docKind,
        });
      }

      const symbols = this.store.findSymbols({
        nameContains: topic.replace(/\s+/g, ''),
        limit: 10,
      });
      for (const symbol of symbols) {
        hits.push({
          score: symbol.isWidgetTest ? 35 : 20,
          repository: symbol.repositoryName,
          file: symbol.filePath,
          title: symbol.name,
          line: symbol.line,
          snippet: symbol.docstring?.split('\n')[0] ?? `${symbol.kind} ${symbol.name}`,
          source: 'symbol',
        });
      }

      hits.sort((a, b) => b.score - a.score);

      return toolOk({
        topic,
        results: dedupeHits(hits).slice(0, limit),
        knowledgeBase,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}

function sourceFromKind(
  kind: string,
  repositoryName: string,
): BestPracticeHit['source'] {
  if (kind === 'migration') return 'migration';
  if (kind === 'cookbook') return 'cookbook';
  if (kind === 'changelog') return 'changelog';
  if (repositoryName === 'flutter/website' || repositoryName === 'dart-lang/site-www') {
    return 'website';
  }
  if (repositoryName === 'flutter/samples') return 'samples';
  return 'docs';
}

function scoreDoc(
  filePath: string,
  title: string | null,
  docKind: string,
  repositoryName: string,
): number {
  let score =
    docKind === 'migration'
      ? 140
      : docKind === 'cookbook'
        ? 130
        : docKind === 'changelog'
          ? 110
          : docKind === 'guide'
            ? 100
            : 50;

  if (repositoryName === 'flutter/website' || repositoryName === 'dart-lang/site-www') {
    score += 15;
  }
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.includes('best-pract')) {
    score += 40;
  }
  if (title && /best|practice|recommend|avoid|prefer|migrat/i.test(title)) {
    score += 25;
  }
  return score;
}

function dedupeHits(hits: readonly BestPracticeHit[]): BestPracticeHit[] {
  const seen = new Set<string>();
  const out: BestPracticeHit[] = [];
  for (const hit of hits) {
    const key = `${hit.repository}:${hit.file}:${hit.line}:${hit.title ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

import { inject, injectable } from 'tsyringe';
import type { KnowledgeStore } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import type { OfficialReference } from './types.js';

const OFFICIAL_REPOS = [
  'flutter/flutter',
  'flutter/website',
  'flutter/samples',
  'flutter/packages',
  'dart-lang/sdk',
  'dart-lang/site-www',
] as const;

@injectable()
export class OfficialReferenceResolver {
  constructor(@inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore) {}

  lookupSymbol(name: string): OfficialReference | undefined {
    for (const repo of OFFICIAL_REPOS) {
      const hit =
        this.store.getSymbolByName(name, { repositoryName: repo }) ??
        this.store.getSymbolByName(name, { isWidget: true, repositoryName: repo });
      if (hit) {
        return {
          repository: hit.repositoryName,
          file: hit.filePath,
          line: hit.line,
        };
      }
    }
    const any = this.store.getSymbolByName(name);
    if (any) {
      return {
        repository: any.repositoryName,
        file: any.filePath,
        line: any.line,
      };
    }
    return undefined;
  }

  lookupDoc(query: string): OfficialReference | undefined {
    for (const repo of ['flutter/website', 'dart-lang/site-www', 'flutter/samples'] as const) {
      const hits = this.store.findDocs({ query, repositoryName: repo, limit: 1 });
      const hit = hits[0];
      if (hit) {
        return {
          repository: hit.repositoryName,
          file: hit.filePath,
          line: hit.lineStart,
        };
      }
    }
    return undefined;
  }
}

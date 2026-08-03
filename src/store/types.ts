/**
 * Knowledge store abstractions for Phase 2+ indexing.
 */

export type FileKind = 'dart' | 'md' | 'other';

export type DocKind = 'changelog' | 'migration' | 'guide' | 'cookbook' | 'general';

export type SymbolKind =
  | 'class'
  | 'mixin'
  | 'enum'
  | 'extension'
  | 'typedef'
  | 'function'
  | 'method'
  | 'constructor'
  | 'other';

export interface RepositoryRecord {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly commitHash: string | null;
  readonly indexedAt: string | null;
}

export interface FileRecord {
  readonly id: number;
  readonly repositoryId: number;
  readonly path: string;
  readonly kind: FileKind;
  readonly hash: string;
  readonly mtimeMs: number;
}

export interface SymbolRecord {
  readonly id: number;
  readonly fileId: number;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly isWidget: boolean;
  readonly isWidgetTest: boolean;
  readonly docstring: string | null;
  readonly packageName: string | null;
  readonly extendsClause: string | null;
  readonly withClause: string | null;
  readonly implementsClause: string | null;
}

export interface DocRecord {
  readonly id: number;
  readonly fileId: number;
  readonly title: string | null;
  readonly chunk: string;
  readonly lineStart: number;
  readonly docKind: DocKind;
}

export interface SymbolSearchHit {
  readonly symbolId: number;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly isWidget: boolean;
  readonly isWidgetTest: boolean;
  readonly docstring: string | null;
  readonly packageName: string | null;
  readonly extendsClause: string | null;
  readonly withClause: string | null;
  readonly implementsClause: string | null;
  readonly filePath: string;
  readonly repositoryName: string;
  readonly repositoryPath: string;
}

export interface DocSearchHit {
  readonly docId: number;
  readonly title: string | null;
  readonly chunk: string;
  readonly lineStart: number;
  readonly docKind: DocKind;
  readonly filePath: string;
  readonly repositoryName: string;
}

export interface UpsertRepositoryInput {
  readonly name: string;
  readonly path: string;
  readonly commitHash: string | null;
}

export interface UpsertFileInput {
  readonly repositoryId: number;
  readonly path: string;
  readonly kind: FileKind;
  readonly hash: string;
  readonly mtimeMs: number;
}

export interface InsertSymbolInput {
  readonly fileId: number;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly isWidget: boolean;
  readonly isWidgetTest?: boolean;
  readonly docstring: string | null;
  readonly packageName: string | null;
  readonly extendsClause?: string | null;
  readonly withClause?: string | null;
  readonly implementsClause?: string | null;
}

export interface InsertDocInput {
  readonly fileId: number;
  readonly title: string | null;
  readonly chunk: string;
  readonly lineStart: number;
  readonly docKind?: DocKind;
}

export interface IndexStats {
  readonly schemaVersion: number;
  readonly lastFullIndex: string | null;
  readonly repositoryCount: number;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly docCount: number;
}

export interface KnowledgeStore {
  open(): void;
  close(): void;
  getStats(): IndexStats;
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;

  upsertRepository(input: UpsertRepositoryInput): RepositoryRecord;
  getRepositoryByName(name: string): RepositoryRecord | null;
  listRepositories(): readonly RepositoryRecord[];
  markRepositoryIndexed(id: number, commitHash: string | null): void;

  getFileByPath(repositoryId: number, relativePath: string): FileRecord | null;
  listFiles(repositoryId: number): readonly FileRecord[];
  upsertFile(input: UpsertFileInput): FileRecord;
  deleteFile(fileId: number): void;
  deleteFilesNotIn(repositoryId: number, relativePaths: readonly string[]): number;

  replaceSymbolsForFile(fileId: number, symbols: readonly InsertSymbolInput[]): void;
  replaceDocsForFile(fileId: number, docs: readonly InsertDocInput[]): void;

  findSymbols(options: {
    readonly name?: string;
    readonly nameContains?: string;
    readonly isWidget?: boolean;
    readonly isWidgetTest?: boolean;
    readonly repositoryName?: string;
    readonly kind?: SymbolKind;
    readonly underTest?: boolean;
    readonly underExample?: boolean;
    readonly limit?: number;
  }): readonly SymbolSearchHit[];

  findDocs(options: {
    readonly query: string;
    readonly repositoryName?: string;
    readonly docKind?: DocKind;
    readonly docKinds?: readonly DocKind[];
    readonly limit?: number;
  }): readonly DocSearchHit[];

  getSymbolByName(
    name: string,
    options?: { readonly isWidget?: boolean; readonly repositoryName?: string },
  ): SymbolSearchHit | null;
}

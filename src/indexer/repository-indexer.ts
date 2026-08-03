import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { inject, injectable } from 'tsyringe';
import type { DartAnalyzerClient } from '../parser/dart-analyzer-client.js';
import type { SymbolExtractor } from '../parser/heuristic-extractor.js';
import type { RepositoryManager } from '../repository/types.js';
import type { KnowledgeStore } from '../store/types.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { AppError } from '../utils/errors.js';
import {
  classifyDocKind,
  classifyFileKind,
  isDocumentationPath,
  isWidgetTestPath,
} from './classify.js';

const INDEX_GLOBS = [
  '**/*.{dart,md,markdown,txt}',
  '**/CHANGELOG',
  '**/CHANGELOG.*',
  '**/changelog',
  '**/changelog.*',
] as const;

const IGNORE_PATTERNS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.dart_tool/**',
  '**/build/**',
  '**/.idea/**',
  '**/out/**',
  '**/.flutter-knowledge-meta.json',
] as const;

export interface RepositoryIndexResult {
  readonly repository: string;
  readonly status: 'indexed' | 'skipped_missing' | 'error';
  readonly filesScanned: number;
  readonly filesUpdated: number;
  readonly filesRemoved: number;
  readonly symbolsIndexed: number;
  readonly docsIndexed: number;
  readonly durationMs: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface IndexRunResult {
  readonly mode: 'full' | 'incremental';
  readonly repositories: readonly RepositoryIndexResult[];
  readonly durationMs: number;
}

export interface Indexer {
  indexAll(options?: { readonly force?: boolean }): Promise<IndexRunResult>;
  indexRepository(name: string, options?: { readonly force?: boolean }): Promise<RepositoryIndexResult>;
}

@injectable()
export class RepositoryIndexer implements Indexer {
  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.RepositoryManager) private readonly repositories: RepositoryManager,
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.SymbolExtractor) private readonly extractor: SymbolExtractor,
    @inject(TYPES.DartAnalyzerClient) private readonly analyzer: DartAnalyzerClient,
  ) {}

  async indexAll(options?: { readonly force?: boolean }): Promise<IndexRunResult> {
    const started = Date.now();
    const force = options?.force ?? false;
    const results: RepositoryIndexResult[] = [];

    for (const definition of this.repositories.listDefinitions()) {
      try {
        results.push(await this.indexRepository(definition.name, { force }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof AppError ? error.code : 'IndexError';
        this.logger.error('Failed to index repository', {
          repository: definition.name,
          error: message,
        });
        results.push({
          repository: definition.name,
          status: 'error',
          filesScanned: 0,
          filesUpdated: 0,
          filesRemoved: 0,
          symbolsIndexed: 0,
          docsIndexed: 0,
          durationMs: 0,
          error: { code, message },
        });
      }
    }

    this.store.setMeta('last_full_index', new Date().toISOString());

    return {
      mode: force ? 'full' : 'incremental',
      repositories: results,
      durationMs: Date.now() - started,
    };
  }

  async indexRepository(
    name: string,
    options?: { readonly force?: boolean },
  ): Promise<RepositoryIndexResult> {
    const started = Date.now();
    const force = options?.force ?? false;
    const definition = this.repositories.resolveDefinition(name);
    const status = (await this.repositories.getStatus(definition.name))[0];

    if (!status?.exists) {
      this.logger.warning('Skipping missing repository during index', {
        repository: definition.name,
      });
      return {
        repository: definition.name,
        status: 'skipped_missing',
        filesScanned: 0,
        filesUpdated: 0,
        filesRemoved: 0,
        symbolsIndexed: 0,
        docsIndexed: 0,
        durationMs: Date.now() - started,
      };
    }

    this.logger.info('Indexing repository', {
      repository: definition.name,
      path: status.path,
      force,
    });

    const repoRecord = this.store.upsertRepository({
      name: definition.name,
      path: status.path,
      commitHash: status.commit,
    });

    const files = await fg([...INDEX_GLOBS], {
      cwd: status.path,
      absolute: false,
      onlyFiles: true,
      dot: false,
      ignore: [...IGNORE_PATTERNS],
      followSymbolicLinks: false,
      caseSensitiveMatch: false,
    });

    let filesUpdated = 0;
    let symbolsIndexed = 0;
    let docsIndexed = 0;

    const dartToUpdate: string[] = [];
    const fileContents = new Map<string, { content: string; hash: string; mtimeMs: number }>();

    for (const relativePath of files) {
      const absolutePath = path.join(status.path, relativePath);
      const fileStat = await stat(absolutePath);
      const content = await readFile(absolutePath, 'utf8');
      const hash = createHash('sha1').update(content).digest('hex');
      const existing = this.store.getFileByPath(repoRecord.id, relativePath);

      if (!force && existing && existing.hash === hash) {
        continue;
      }

      fileContents.set(relativePath, { content, hash, mtimeMs: fileStat.mtimeMs });
      if (classifyFileKind(relativePath) === 'dart') {
        dartToUpdate.push(relativePath);
      }
    }

    const analyzerSymbols = new Map<string, ReturnType<DartAnalyzerClient['toInsertSymbols']>>();
    if (dartToUpdate.length > 0) {
      const analysis = await this.analyzer.analyzeFiles(status.path, dartToUpdate);
      if (analysis.available) {
        for (const file of analysis.files) {
          const normalized = file.path.replaceAll('\\', '/');
          const widgetTest = isWidgetTestPath(normalized);
          analyzerSymbols.set(
            normalized,
            this.analyzer.toInsertSymbols(0, file.symbols).map((symbol) => ({
              ...symbol,
              isWidgetTest: widgetTest,
            })),
          );
        }
        this.logger.info('Used Dart analyzer for repository batch', {
          repository: definition.name,
          files: analysis.files.length,
        });
      } else if (analysis.warning) {
        this.logger.warning('Analyzer unavailable during index; using heuristics', {
          repository: definition.name,
          warning: analysis.warning,
        });
      }
    }

    for (const [relativePath, meta] of fileContents) {
      const kind = classifyFileKind(relativePath);
      const fileRecord = this.store.upsertFile({
        repositoryId: repoRecord.id,
        path: relativePath,
        kind,
        hash: meta.hash,
        mtimeMs: meta.mtimeMs,
      });

      if (kind === 'dart') {
        const normalized = relativePath.replaceAll('\\', '/');
        const fromAnalyzer = analyzerSymbols.get(normalized);
        if (fromAnalyzer) {
          this.store.replaceSymbolsForFile(
            fileRecord.id,
            fromAnalyzer.map((symbol) => ({ ...symbol, fileId: fileRecord.id })),
          );
          symbolsIndexed += fromAnalyzer.length;
        } else {
          const extracted = this.extractor.extractDart(meta.content, relativePath);
          this.store.replaceSymbolsForFile(
            fileRecord.id,
            extracted.symbols.map((symbol) => ({ ...symbol, fileId: fileRecord.id })),
          );
          symbolsIndexed += extracted.symbols.length;
        }
        this.store.replaceDocsForFile(fileRecord.id, []);
      } else if (isDocumentationPath(relativePath)) {
        const docKind = classifyDocKind(relativePath);
        const extracted = this.extractor.extractMarkdown(meta.content, relativePath, docKind);
        this.store.replaceDocsForFile(
          fileRecord.id,
          extracted.docs.map((doc) => ({ ...doc, fileId: fileRecord.id, docKind })),
        );
        this.store.replaceSymbolsForFile(fileRecord.id, []);
        docsIndexed += extracted.docs.length;
      } else {
        this.store.replaceSymbolsForFile(fileRecord.id, []);
        this.store.replaceDocsForFile(fileRecord.id, []);
      }

      filesUpdated += 1;
    }

    const filesRemoved = this.store.deleteFilesNotIn(repoRecord.id, files);
    this.store.markRepositoryIndexed(repoRecord.id, status.commit);

    const result: RepositoryIndexResult = {
      repository: definition.name,
      status: 'indexed',
      filesScanned: files.length,
      filesUpdated,
      filesRemoved,
      symbolsIndexed,
      docsIndexed,
      durationMs: Date.now() - started,
    };

    this.logger.info('Repository index complete', { ...result });
    return result;
  }
}

import { inject, injectable } from 'tsyringe';
import type { DartAnalyzerClient } from '../../parser/dart-analyzer-client.js';
import type { SymbolExtractor } from '../../parser/heuristic-extractor.js';
import type { Logger } from '../../types/logger.js';
import { TYPES } from '../../types/tokens.js';
import type { AstMeta, DartFileInfo, SymbolInfo } from '../types.js';

export interface AstExtractionResult {
  readonly symbols: readonly SymbolInfo[];
  readonly astMeta: AstMeta;
}

/**
 * Prefers the official Dart Analyzer helper; falls back to heuristics with
 * reduced confidence and an explicit warning.
 */
@injectable()
export class AstAdapter {
  constructor(
    @inject(TYPES.DartAnalyzerClient) private readonly dartAnalyzer: DartAnalyzerClient,
    @inject(TYPES.SymbolExtractor) private readonly heuristic: SymbolExtractor,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async extractSymbols(
    projectPath: string,
    dartFiles: readonly DartFileInfo[],
  ): Promise<AstExtractionResult> {
    const filesTotal = dartFiles.length;
    if (filesTotal === 0) {
      return {
        symbols: [],
        astMeta: {
          source: 'dart_analyzer',
          coverage: 'none',
          filesAnalyzed: 0,
          filesTotal: 0,
          baseConfidence: 1,
        },
      };
    }

    const relativePaths = dartFiles.map((f) => f.relativePath);
    const run = await this.dartAnalyzer.analyzeFiles(projectPath, relativePaths);

    if (run.available && run.files.length > 0) {
      const byPath = new Map(run.files.map((f) => [normalizePath(f.path), f]));
      const symbols: SymbolInfo[] = [];
      let filesWithSymbols = 0;

      for (const file of dartFiles) {
        const hit = byPath.get(file.relativePath) ?? byPath.get(normalizePath(file.relativePath));
        if (!hit) {
          continue;
        }
        filesWithSymbols += 1;
        for (const symbol of hit.symbols) {
          symbols.push({
            name: symbol.name,
            kind: symbol.kind,
            line: symbol.line,
            isWidget: symbol.isWidget,
            docstring: symbol.docstring,
            extendsClause: symbol.extendsClause,
            withClause: symbol.withClause,
            implementsClause: symbol.implementsClause,
            filePath: file.relativePath,
          });
        }
      }

      const coverage =
        filesWithSymbols >= filesTotal
          ? 'full'
          : filesWithSymbols > 0
            ? 'partial'
            : 'none';

      this.logger.info('AST extraction via Dart Analyzer', {
        filesTotal,
        filesWithSymbols,
        symbolCount: symbols.length,
      });

      return {
        symbols,
        astMeta: {
          source: 'dart_analyzer',
          coverage,
          filesAnalyzed: filesWithSymbols,
          filesTotal,
          warning: run.warning,
          baseConfidence: coverage === 'full' ? 1 : coverage === 'partial' ? 0.92 : 0.85,
        },
      };
    }

    const warning =
      run.warning ??
      'Dart SDK or parser helper not available — using heuristic symbol extraction.';

    this.logger.warning('AST fallback to heuristics', { warning, filesTotal });

    const symbols: SymbolInfo[] = [];
    for (const file of dartFiles) {
      const extracted = this.heuristic.extractDart(file.content, file.relativePath);
      for (const symbol of extracted.symbols) {
        symbols.push({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          isWidget: symbol.isWidget,
          docstring: symbol.docstring,
          extendsClause: symbol.extendsClause ?? null,
          withClause: symbol.withClause ?? null,
          implementsClause: symbol.implementsClause ?? null,
          filePath: file.relativePath,
        });
      }
    }

    return {
      symbols,
      astMeta: {
        source: 'heuristic',
        coverage: 'partial',
        filesAnalyzed: filesTotal,
        filesTotal,
        warning: `${warning} Install the Dart SDK for full-fidelity analysis.`,
        baseConfidence: 0.75,
      },
    };
  }
}

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/');
}

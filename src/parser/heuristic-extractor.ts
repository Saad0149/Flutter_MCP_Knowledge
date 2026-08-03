/**
 * Extracted Dart / markdown units from a single file.
 * Phase 2 uses TypeScript heuristics; Phase 3 may use package:analyzer.
 */

import type { DocKind, InsertDocInput, InsertSymbolInput, SymbolKind } from '../store/types.js';
import { classifyDocKind, isWidgetTestPath } from '../indexer/classify.js';

export interface ExtractedFile {
  readonly symbols: readonly Omit<InsertSymbolInput, 'fileId'>[];
  readonly docs: readonly Omit<InsertDocInput, 'fileId'>[];
}

export interface SymbolExtractor {
  extractDart(content: string, relativePath: string): ExtractedFile;
  extractMarkdown(content: string, relativePath: string, docKind?: DocKind): ExtractedFile;
}

const CLASS_RE =
  /^\s*(?:abstract\s+|sealed\s+|base\s+|final\s+|interface\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/;
const MIXIN_RE = /^\s*(?:base\s+)?mixin\s+([A-Za-z_][A-Za-z0-9_]*)/;
const ENUM_RE = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)/;
const EXTENSION_RE = /^\s*extension\s+([A-Za-z_][A-Za-z0-9_]*)/;
const TYPEDEF_RE = /^\s*typedef\s+(?:[A-Za-z_][A-Za-z0-9_<>\s,]*?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const FUNCTION_RE =
  /^\s*(?:(?:Future|Stream|void|int|double|bool|String|num|dynamic|Object|List|Map|Set)[\w<>,\s?]*\s+|)\s*([a-z][A-Za-z0-9_]*)\s*\(/;

const EXTENDS_RE = /\bextends\s+([A-Za-z_][A-Za-z0-9_.<>,\s?]*)/;
const WITH_RE = /\bwith\s+([A-Za-z_][A-Za-z0-9_.<>,\s?]*)/;
const IMPLEMENTS_RE = /\bimplements\s+([A-Za-z_][A-Za-z0-9_.<>,\s?]*)/;

const WIDGET_HINT_RE = /Widget|StatelessWidget|StatefulWidget|RenderObjectWidget/;

/**
 * Line-oriented Dart extractor.
 * Not a full parser — expect false positives/negatives until Phase 3 analyzer.
 */
export class HeuristicSymbolExtractor implements SymbolExtractor {
  extractDart(content: string, relativePath: string): ExtractedFile {
    const lines = content.split(/\r?\n/);
    const symbols: Omit<InsertSymbolInput, 'fileId'>[] = [];
    const packageName = inferPackage(relativePath);
    const widgetTest = isWidgetTestPath(relativePath);
    let pendingDocs: string[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();

      if (trimmed.startsWith('///')) {
        pendingDocs.push(trimmed.replace(/^\/\/\/\s?/, ''));
        continue;
      }

      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        if (!trimmed.startsWith('///')) {
          // keep docs only when immediately above a declaration
          if (trimmed !== '' && !trimmed.startsWith('//')) {
            pendingDocs = [];
          }
        }
        continue;
      }

      const docstring = pendingDocs.length > 0 ? pendingDocs.join('\n') : null;
      pendingDocs = [];

      const classMatch = CLASS_RE.exec(line);
      if (classMatch?.[1]) {
        const name = classMatch[1];
        const extendsClause = captureClause(line, lines, i, EXTENDS_RE);
        const withClause = captureClause(line, lines, i, WITH_RE);
        const implementsClause = captureClause(line, lines, i, IMPLEMENTS_RE);
        symbols.push({
          name,
          kind: 'class',
          line: i + 1,
          isWidget: isWidgetSymbol(name, extendsClause, withClause, implementsClause),
          isWidgetTest: widgetTest,
          docstring,
          packageName,
          extendsClause,
          withClause,
          implementsClause,
        });
        continue;
      }

      const mixinMatch = MIXIN_RE.exec(line);
      if (mixinMatch?.[1]) {
        symbols.push({
          name: mixinMatch[1],
          kind: 'mixin',
          line: i + 1,
          isWidget: false,
          isWidgetTest: widgetTest,
          docstring,
          packageName,
          extendsClause: null,
          withClause: null,
          implementsClause: null,
        });
        continue;
      }

      const enumMatch = ENUM_RE.exec(line);
      if (enumMatch?.[1]) {
        symbols.push({
          name: enumMatch[1],
          kind: 'enum',
          line: i + 1,
          isWidget: false,
          isWidgetTest: widgetTest,
          docstring,
          packageName,
          extendsClause: null,
          withClause: null,
          implementsClause: null,
        });
        continue;
      }

      const extensionMatch = EXTENSION_RE.exec(line);
      if (extensionMatch?.[1]) {
        symbols.push({
          name: extensionMatch[1],
          kind: 'extension',
          line: i + 1,
          isWidget: false,
          isWidgetTest: widgetTest,
          docstring,
          packageName,
          extendsClause: null,
          withClause: null,
          implementsClause: null,
        });
        continue;
      }

      const typedefMatch = TYPEDEF_RE.exec(line);
      if (typedefMatch?.[1]) {
        symbols.push({
          name: typedefMatch[1],
          kind: 'typedef',
          line: i + 1,
          isWidget: false,
          isWidgetTest: widgetTest,
          docstring,
          packageName,
          extendsClause: null,
          withClause: null,
          implementsClause: null,
        });
        continue;
      }

      // Skip obvious class members / constructors by requiring top-level-ish indentation
      if (/^\s{0,2}/.test(line) && !line.includes('=>') && FUNCTION_RE.test(line)) {
        const fnMatch = FUNCTION_RE.exec(line);
        const name = fnMatch?.[1];
        if (name && !['if', 'for', 'while', 'switch', 'return', 'await'].includes(name)) {
          symbols.push({
            name,
            kind: 'function' satisfies SymbolKind,
            line: i + 1,
            isWidget: false,
            isWidgetTest: widgetTest,
            docstring,
            packageName,
            extendsClause: null,
            withClause: null,
            implementsClause: null,
          });
        }
      }
    }

    return { symbols, docs: [] };
  }

  extractMarkdown(
    content: string,
    relativePath: string,
    docKind?: DocKind,
  ): ExtractedFile {
    const kind = docKind ?? classifyDocKind(relativePath);
    const lines = content.split(/\r?\n/);
    const docs: Omit<InsertDocInput, 'fileId'>[] = [];
    let currentTitle: string | null = null;
    let chunkLines: string[] = [];
    let chunkStart = 1;

    const flush = (): void => {
      const chunk = chunkLines.join('\n').trim();
      if (chunk.length > 0) {
        docs.push({
          title: currentTitle,
          chunk: chunk.slice(0, 4000),
          lineStart: chunkStart,
          docKind: kind,
        });
      }
      chunkLines = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flush();
        currentTitle = heading[2]?.trim() ?? null;
        chunkStart = i + 1;
        chunkLines = [line];
        continue;
      }
      chunkLines.push(line);
      if (chunkLines.join('\n').length > 3500) {
        flush();
        chunkStart = i + 2;
      }
    }
    flush();

    return { symbols: [], docs };
  }
}

function captureClause(
  firstLine: string,
  lines: readonly string[],
  index: number,
  pattern: RegExp,
): string | null {
  // Declaration may span a few lines until `{` or `;`
  const window = [firstLine, lines[index + 1] ?? '', lines[index + 2] ?? ''].join(' ');
  const match = pattern.exec(window);
  if (!match?.[1]) {
    return null;
  }
  return match[1].split('{')[0]?.trim() || null;
}

function isWidgetSymbol(
  name: string,
  extendsClause: string | null,
  withClause: string | null,
  implementsClause: string | null,
): boolean {
  if (name.endsWith('Widget') || name === 'Widget') {
    return true;
  }
  const haystack = [extendsClause, withClause, implementsClause].filter(Boolean).join(' ');
  return WIDGET_HINT_RE.test(haystack);
}

/**
 * Best-effort package inference from path segments.
 * Example: packages/flutter/lib/src/widgets/x.dart → flutter
 */
export function inferPackage(relativePath: string): string | null {
  const normalized = relativePath.replaceAll('\\', '/');
  const packagesIdx = normalized.indexOf('packages/');
  if (packagesIdx >= 0) {
    const rest = normalized.slice(packagesIdx + 'packages/'.length);
    const pkg = rest.split('/')[0];
    return pkg || null;
  }
  if (normalized.startsWith('lib/')) {
    return 'flutter';
  }
  return null;
}

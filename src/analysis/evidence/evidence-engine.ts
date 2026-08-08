import { injectable } from 'tsyringe';
import type { AnalysisFinding, AnalysisSource, EvidenceItem, ProjectSnapshot } from '../types.js';

/**
 * Converts string evidence / finding context into structured EvidenceItem entries.
 * Does not invent facts — only structures what analyzers already measured.
 */
@injectable()
export class EvidenceEngine {
  enrichFinding(
    finding: AnalysisFinding,
    snapshot: ProjectSnapshot,
    analyzerName: string,
  ): AnalysisFinding {
    if (finding.evidenceItems && finding.evidenceItems.length > 0) {
      return {
        ...finding,
        id: finding.id ?? makeFindingId(finding),
      };
    }

    const items = this.buildItems(finding, snapshot, analyzerName);
    return {
      ...finding,
      id: finding.id ?? makeFindingId(finding),
      evidenceItems: items,
      evidence:
        finding.evidence.length > 0
          ? finding.evidence
          : items.map((i) => formatEvidenceSummary(i)),
    };
  }

  enrichAll(
    findings: readonly AnalysisFinding[],
    snapshot: ProjectSnapshot,
    analyzerByCode?: ReadonlyMap<string, string>,
  ): AnalysisFinding[] {
    return findings.map((f) =>
      this.enrichFinding(f, snapshot, analyzerByCode?.get(f.code) ?? inferAnalyzer(f)),
    );
  }

  private buildItems(
    finding: AnalysisFinding,
    snapshot: ProjectSnapshot,
    analyzerName: string,
  ): EvidenceItem[] {
    const items: EvidenceItem[] = [];
    const source = finding.source;
    const confidence = finding.confidence;

    if (finding.file) {
      items.push({
        file: finding.file,
        line: finding.line ?? null,
        column: null,
        symbol: extractSymbolHint(finding),
        astNode: null,
        analyzer: analyzerName,
        confidence,
        source,
        detail: finding.title,
      });
    }

    for (const raw of finding.evidence) {
      const parsed = parseEvidenceString(raw, source, confidence, analyzerName);
      if (parsed) {
        items.push(parsed);
        continue;
      }
      items.push({
        file: null,
        line: null,
        column: null,
        symbol: null,
        astNode: null,
        analyzer: analyzerName,
        confidence,
        source,
        detail: raw,
      });
    }

    // Attach concrete import-edge hits for layer violations
    if (finding.code === 'PresentationImportsData') {
      for (const edge of findLayerLeakEdges(snapshot, 'presentation', 'data').slice(0, 8)) {
        items.push({
          file: edge.from,
          line: null,
          column: null,
          symbol: null,
          astNode: 'import',
          analyzer: 'ImportGraph',
          confidence: Math.min(1, confidence),
          source: 'import_graph',
          detail: `${edge.from} imports ${edge.to}`,
        });
      }
    }

    if (finding.code === 'DomainImportsData' || finding.code === 'DomainImportsFlutter') {
      for (const edge of findDomainViolations(snapshot, finding.code).slice(0, 8)) {
        items.push({
          file: edge.from,
          line: null,
          column: null,
          symbol: null,
          astNode: 'import',
          analyzer: 'ImportGraph',
          confidence: 1,
          source: 'import_graph',
          detail: edge.detail,
        });
      }
    }

    if (finding.code === 'GodClassCandidate') {
      // CodeQualityAnalyzer emits GodClassCandidate evidence as
      // "Name @ path/to/file.dart: score=N, conf=P%, signals=a|b|c" — NOT the
      // "Name (path/to/file.dart)" shape the old regex here expected (that
      // shape belongs to the separate, unused `godClassCandidates` legacy
      // field). The mismatch meant this branch silently matched nothing,
      // leaving GodClassCandidate's evidenceItems without a `file`, which is
      // what sampleFilesFor() reads to build topRisks/topActions sampleFiles.
      for (const raw of finding.evidence.slice(0, 10)) {
        const m = /^(\w+)\s+@\s+(.+?\.dart):/.exec(raw);
        if (m) {
          const file = m[2]!;
          const symbol = m[1]!;
          const fileInfo = snapshot.dartFiles.find((f) => f.relativePath === file);
          items.push({
            file,
            line: null,
            column: null,
            symbol,
            astNode: 'class',
            analyzer: analyzerName,
            confidence,
            source,
            detail: `${symbol} in ${file} (~${fileInfo?.lineCount ?? '?'} LOC)`,
          });
        }
      }
    }

    if (finding.code === 'CircularDependencies') {
      for (const cycle of finding.evidence.slice(0, 5)) {
        items.push({
          file: cycle.split(' -> ')[0] ?? null,
          line: null,
          column: null,
          symbol: null,
          astNode: 'import_cycle',
          analyzer: 'ImportGraph',
          confidence,
          source: 'import_graph',
          detail: cycle,
        });
      }
    }

    return dedupeEvidence(items);
  }
}

export function makeFindingId(finding: AnalysisFinding): string {
  const loc = finding.file ? `:${finding.file}:${finding.line ?? 0}` : '';
  return `${finding.code}${loc}`.replace(/[^A-Za-z0-9_.:/-]/g, '_');
}

function formatEvidenceSummary(item: EvidenceItem): string {
  const loc =
    item.file != null
      ? item.line != null
        ? `${item.file}:${item.line}`
        : item.file
      : null;
  const parts = [loc, item.symbol, item.detail].filter(Boolean);
  return parts.join(' — ');
}

function extractSymbolHint(finding: AnalysisFinding): string | null {
  const fromTitle = /\b([A-Z][A-Za-z0-9_]+)\b/.exec(finding.title);
  return fromTitle?.[1] ?? null;
}

function parseEvidenceString(
  raw: string,
  source: AnalysisSource,
  confidence: number,
  analyzer: string,
): EvidenceItem | null {
  // path:line (~N lines)
  const build = /^(.+\.dart):(\d+)\s+\(~(\d+)\s+lines\)$/.exec(raw);
  if (build) {
    return {
      file: build[1]!,
      line: Number(build[2]),
      column: null,
      symbol: 'build',
      astNode: 'method',
      analyzer,
      confidence,
      source,
      detail: `approx ${build[3]} lines`,
    };
  }

  // Symbol at path:line
  const at = /^(\S+)\s+at\s+(.+\.dart):(\d+)$/.exec(raw);
  if (at) {
    return {
      file: at[2]!,
      line: Number(at[3]),
      column: null,
      symbol: at[1]!,
      astNode: null,
      analyzer,
      confidence,
      source,
      detail: raw,
    };
  }

  // Class (path)
  const cls = /^(\w+)\s+\((.+\.dart)\)$/.exec(raw);
  if (cls) {
    return {
      file: cls[2]!,
      line: null,
      column: null,
      symbol: cls[1]!,
      astNode: 'class',
      analyzer,
      confidence,
      source,
      detail: raw,
    };
  }

  return null;
}

function findLayerLeakEdges(
  snapshot: ProjectSnapshot,
  fromLayer: string,
  toLayer: string,
): { from: string; to: string }[] {
  const hits: { from: string; to: string }[] = [];
  for (const file of snapshot.dartFiles) {
    const pathLower = file.relativePath.toLowerCase();
    const isFrom =
      fromLayer === 'presentation'
        ? /\/(presentation|ui|views|screens|pages|widgets)\//.test(pathLower)
        : pathLower.includes(`/${fromLayer}/`);
    if (!isFrom) continue;
    for (const imp of file.imports) {
      if (imp.toLowerCase().includes(`/${toLayer}/`) || imp.toLowerCase().includes('repository_impl')) {
        hits.push({ from: file.relativePath, to: imp });
      }
    }
  }
  return hits;
}

function findDomainViolations(
  snapshot: ProjectSnapshot,
  code: string,
): { from: string; detail: string }[] {
  const hits: { from: string; detail: string }[] = [];
  for (const file of snapshot.dartFiles) {
    if (!file.relativePath.toLowerCase().includes('/domain/')) continue;
    for (const imp of file.imports) {
      const impLower = imp.toLowerCase();
      if (code === 'DomainImportsFlutter' && (impLower.startsWith('package:flutter/') || impLower === 'package:flutter')) {
        hits.push({ from: file.relativePath, detail: `${file.relativePath} imports ${imp}` });
      }
      if (code === 'DomainImportsData' && impLower.includes('/data/')) {
        hits.push({ from: file.relativePath, detail: `${file.relativePath} imports ${imp}` });
      }
    }
  }
  return hits;
}

function inferAnalyzer(finding: AnalysisFinding): string {
  switch (finding.category) {
    case 'architecture':
    case 'dependency':
      return 'ArchitectureAnalyzer';
    case 'state_management':
      return 'StateManagementAnalyzer';
    default:
      return 'CodeQualityAnalyzer';
  }
}

function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.file}|${item.line}|${item.symbol}|${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

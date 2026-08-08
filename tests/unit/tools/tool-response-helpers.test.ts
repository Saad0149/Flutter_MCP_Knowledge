import { describe, expect, it } from 'vitest';
import type { AnalysisFinding, EvidenceItem } from '../../../src/analysis/types.js';
import type { StoredAnalysisSession } from '../../../src/analysis/session/analysis-session-store.js';
import {
  checkAnalyzableSession,
  filterFindingsByScope,
  sampleFilesFor,
  withSizeMetadata,
} from '../../../src/tools/tool-response-helpers.js';

function makeEvidence(file: string | null): EvidenceItem {
  return {
    file,
    line: null,
    column: null,
    symbol: null,
    astNode: null,
    analyzer: 'heuristic',
    confidence: 0.9,
    source: 'heuristic',
    detail: 'x',
  };
}

function makeFinding(overrides: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    severity: 'negative',
    category: 'dependency',
    code: 'SomeFinding',
    title: 'Some finding',
    description: 'desc',
    evidence: [],
    recommendedFix: null,
    confidence: 0.9,
    source: 'heuristic',
    ...overrides,
  };
}

function makeSession(dartFileCount: number): StoredAnalysisSession {
  return {
    sessionId: 'sess1',
    createdAt: new Date().toISOString(),
    projectPath: '/tmp/proj',
    report: {
      metrics: { dartFileCount } as StoredAnalysisSession['report']['metrics'],
    } as StoredAnalysisSession['report'],
  };
}

describe('checkAnalyzableSession', () => {
  it('returns null when the project has Dart files', () => {
    expect(checkAnalyzableSession(makeSession(5))).toBeNull();
  });

  it('returns a blocked result with reason=no_dart_files when there are none', () => {
    const result = checkAnalyzableSession(makeSession(0));
    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'no_dart_files',
      sessionId: 'sess1',
      projectPath: '/tmp/proj',
    });
  });
});

describe('sampleFilesFor', () => {
  it('returns [] for an undefined finding', () => {
    expect(sampleFilesFor(undefined)).toEqual([]);
  });

  it('pulls from finding.file and evidenceItems[].file, deduped, capped at max', () => {
    const finding = makeFinding({
      file: 'lib/a.dart',
      evidenceItems: [
        makeEvidence('lib/a.dart'), // duplicate of finding.file
        makeEvidence('lib/b.dart'),
        makeEvidence('lib/c.dart'),
        makeEvidence('lib/d.dart'),
        makeEvidence(null),
      ],
    });
    const result = sampleFilesFor(finding, 3);
    expect(result.length).toBe(3);
    expect(result).toEqual(['lib/a.dart', 'lib/b.dart', 'lib/c.dart']);
  });

  it('never fabricates a path — only returns what evidence actually contains', () => {
    const finding = makeFinding({ evidenceItems: [makeEvidence(null)] });
    expect(sampleFilesFor(finding)).toEqual([]);
  });
});

describe('filterFindingsByScope', () => {
  const admin = makeFinding({ code: 'A', file: 'lib/features/admin/page.dart' });
  const billing = makeFinding({ code: 'B', file: 'lib/features/billing/page.dart' });
  const noLocation = makeFinding({ code: 'C' });
  const all = [admin, billing, noLocation];

  it('returns everything unchanged when no scope is given', () => {
    expect(filterFindingsByScope(all, {})).toBe(all);
  });

  it('feature scoping keeps only findings under that feature folder', () => {
    const result = filterFindingsByScope(all, { feature: 'admin' });
    expect(result.map((f) => f.code)).toEqual(['A']);
  });

  it('pathGlob scoping supports ** and keeps only matching findings', () => {
    const result = filterFindingsByScope(all, { pathGlob: 'lib/features/billing/**' });
    expect(result.map((f) => f.code)).toEqual(['B']);
  });

  it('drops findings with no known file location when a scope is active', () => {
    const result = filterFindingsByScope(all, { feature: 'admin' });
    expect(result.some((f) => f.code === 'C')).toBe(false);
  });

  it('a scope matching nothing returns an empty array, not the unfiltered set', () => {
    expect(filterFindingsByScope(all, { feature: 'nonexistent' })).toEqual([]);
  });

  it('checks evidenceItems file paths too, not just finding.file', () => {
    const finding = makeFinding({
      code: 'D',
      evidenceItems: [makeEvidence('lib/features/reports/x.dart')],
    });
    const result = filterFindingsByScope([finding], { feature: 'reports' });
    expect(result.length).toBe(1);
  });

  it('SECURITY: a pathGlob with many chained ** segments does not hang (ReDoS regression)', () => {
    // Pre-fix, globToRegExp compiled each '**' to an adjacent `.*` with no
    // collapsing, so a chain like "**/**/**/.../nomatch" produced N adjacent
    // `.*` groups — catastrophic backtracking against a long non-matching
    // path. A 10-segment chain hung for 20+ seconds pre-fix; this uses 25 to
    // leave real margin. If this regresses, the test times out (vitest's
    // default per-test timeout), which is the loud failure we want.
    const pathologicalGlob = `${Array(25).fill('**').join('/')}/nomatch`;
    const longNonMatchingFile = `${'a/'.repeat(200)}zzz.dart`;
    const finding = makeFinding({ code: 'E', file: longNonMatchingFile });

    const start = performance.now();
    const result = filterFindingsByScope([finding], { pathGlob: pathologicalGlob });
    const elapsedMs = performance.now() - start;

    expect(result).toEqual([]); // legitimately doesn't match — collapsing changes perf, not semantics
    expect(elapsedMs).toBeLessThan(200);
  });

  it('collapsing consecutive ** segments preserves normal glob semantics', () => {
    const result = filterFindingsByScope(all, { pathGlob: '**/**/billing/**' });
    expect(result.map((f) => f.code)).toEqual(['B']);
  });
});

describe('withSizeMetadata', () => {
  it('adds bytes and a consistent approxTokens estimate', () => {
    const result = withSizeMetadata({ a: 1, b: 'hello' });
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.approxTokens).toBe(Math.ceil(result.bytes / 4));
    expect(result.a).toBe(1);
    expect(result.b).toBe('hello');
  });

  it('scales roughly with payload size', () => {
    const small = withSizeMetadata({ x: 'a' });
    const big = withSizeMetadata({ x: 'a'.repeat(1000) });
    expect(big.bytes).toBeGreaterThan(small.bytes);
  });
});

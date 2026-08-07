import { describe, expect, it } from 'vitest';
import type { AnalysisFinding, EvidenceItem } from '../../../src/analysis/index.js';
import {
  capEvidence,
  omitEmpty,
  resolveShapeOptions,
  selectFields,
  summarizeCyclePaths,
} from '../../../src/tools/finding-response-shape.js';

function makeEvidence(n: number): EvidenceItem[] {
  return Array.from({ length: n }, (_, i) => ({
    file: `lib/file_${i}.dart`,
    line: i + 1,
    column: null,
    symbol: `Symbol${i}`,
    astNode: null,
    analyzer: 'heuristic',
    confidence: 0.9,
    source: 'heuristic',
    detail: `detail ${i}`,
  }));
}

function baseFinding(overrides: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    severity: 'negative',
    category: 'dependency',
    code: 'SomeFinding',
    title: 'Some finding',
    description: 'A description',
    evidence: [],
    recommendedFix: null,
    confidence: 0.9,
    source: 'heuristic',
    ...overrides,
  };
}

describe('resolveShapeOptions', () => {
  it('defaults to verbosity=normal, maxEvidence=5, includeRelated=true, includeOfficialRefs=true', () => {
    const shape = resolveShapeOptions({});
    expect(shape.verbosity).toBe('normal');
    expect(shape.maxEvidence).toBe(5);
    expect(shape.includeRelated).toBe(true);
    expect(shape.includeOfficialRefs).toBe(true);
    expect(shape.fields).toBeUndefined();
  });

  it('defaults includeRelated to false for verbosity=brief', () => {
    const shape = resolveShapeOptions({ verbosity: 'brief' });
    expect(shape.includeRelated).toBe(false);
  });

  it('an explicit includeRelated always wins over the verbosity preset default', () => {
    expect(resolveShapeOptions({ verbosity: 'brief', includeRelated: true }).includeRelated).toBe(
      true,
    );
    expect(resolveShapeOptions({ verbosity: 'full', includeRelated: false }).includeRelated).toBe(
      false,
    );
  });

  it('respects an explicit maxEvidence override', () => {
    expect(resolveShapeOptions({ maxEvidence: 12 }).maxEvidence).toBe(12);
  });
});

describe('capEvidence', () => {
  it('returns everything with no omitted count when under the cap', () => {
    const { evidence, evidenceOmittedCount } = capEvidence(makeEvidence(3), 5);
    expect(evidence.length).toBe(3);
    expect(evidenceOmittedCount).toBeUndefined();
  });

  it('truncates and reports the omitted count instead of silently dropping items', () => {
    const { evidence, evidenceOmittedCount } = capEvidence(makeEvidence(12), 5);
    expect(evidence.length).toBe(5);
    expect(evidenceOmittedCount).toBe(7);
  });

  it('reports no omission when exactly at the cap', () => {
    const { evidence, evidenceOmittedCount } = capEvidence(makeEvidence(5), 5);
    expect(evidence.length).toBe(5);
    expect(evidenceOmittedCount).toBeUndefined();
  });
});

describe('summarizeCyclePaths', () => {
  it('returns undefined for non-cycle findings', () => {
    expect(summarizeCyclePaths(baseFinding({ code: 'PresentationImportsData' }))).toBeUndefined();
  });

  it('summarizes cycle count and identifies the most-connected hub file', () => {
    const finding = baseFinding({
      code: 'CircularDependencies',
      title: '9 circular import cycle(s) detected',
      evidence: [
        'a.dart → b.dart → app_snack_bar.dart → a.dart',
        'c.dart → app_snack_bar.dart → d.dart → c.dart',
        'e.dart → app_snack_bar.dart → f.dart → e.dart',
      ],
    });
    const summary = summarizeCyclePaths(finding);
    expect(summary).toContain('9 cycle');
    expect(summary).toContain('app_snack_bar.dart');
    // Must not repeat the full raw list — explore_finding owns that.
    expect(summary).not.toContain('a.dart → b.dart');
  });

  it('handles the "->" separator variant used elsewhere in the codebase', () => {
    const finding = baseFinding({
      code: 'CircularDependencies',
      title: '2 circular import cycle(s) detected',
      evidence: ['x.dart -> hub.dart -> x.dart', 'y.dart -> hub.dart -> y.dart'],
    });
    expect(summarizeCyclePaths(finding)).toContain('hub.dart');
  });
});

describe('omitEmpty', () => {
  it('drops null, undefined, empty arrays, and blank strings', () => {
    const result = omitEmpty({
      a: 'kept',
      b: null,
      c: undefined,
      d: [],
      e: ['x'],
      f: '',
      g: '   ',
      h: 0,
      i: false,
    });
    expect(result).toEqual({ a: 'kept', e: ['x'], h: 0, i: false });
  });
});

describe('selectFields', () => {
  it('returns the object unchanged when no fields allowlist is given', () => {
    const obj = { a: 1, b: 2 };
    expect(selectFields(obj, undefined, ['a'])).toEqual(obj);
  });

  it('keeps only allowlisted fields plus always-keep keys', () => {
    const obj = { sessionId: 's1', a: 1, b: 2, c: 3 };
    expect(selectFields(obj, ['a'], ['sessionId'])).toEqual({ sessionId: 's1', a: 1 });
  });
});

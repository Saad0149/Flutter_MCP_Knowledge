/**
 * Confidence helpers shared by analyzer engines.
 */
import type { AnalysisFinding, AnalysisSource, AstMeta, FindingBasis, OfficialReference } from '../types.js';
import { withAstConfidence } from '../types.js';

export type FindingDraft = Omit<AnalysisFinding, 'confidence' | 'source'> & {
  readonly confidence?: number;
  readonly source?: AnalysisSource;
  readonly dependsOnAst?: boolean;
};

export function finding(
  draft: FindingDraft,
  astMeta: AstMeta,
): AnalysisFinding {
  const dependsOnAst = draft.dependsOnAst ?? false;
  const base = draft.confidence ?? defaultBaseConfidence(draft.source ?? inferDefaultSource(dependsOnAst));
  const source = draft.source ?? (dependsOnAst ? astMeta.source : 'filesystem');
  const refs = collectRefs(draft);

  return {
    severity: draft.severity,
    category: draft.category,
    code: draft.code,
    title: draft.title,
    description: draft.description,
    evidence: draft.evidence,
    recommendedFix: draft.recommendedFix,
    confidence: withAstConfidence(base, astMeta, dependsOnAst),
    source: dependsOnAst && source === 'filesystem' ? astMeta.source : source,
    basis: draft.basis,
    whyItMatters: draft.whyItMatters,
    scoreImpact: draft.scoreImpact,
    file: draft.file,
    line: draft.line,
    officialReference: draft.officialReference ?? refs[0],
    officialReferences: refs.length > 0 ? refs : draft.officialReferences,
  };
}

function inferDefaultSource(dependsOnAst: boolean): AnalysisSource {
  return dependsOnAst ? 'heuristic' : 'filesystem';
}

function defaultBaseConfidence(source: AnalysisSource): number {
  switch (source) {
    case 'dart_analyzer':
      return 1;
    case 'pubspec':
      return 0.98;
    case 'filesystem':
      return 0.95;
    case 'import_graph':
      return 0.9;
    case 'heuristic':
      return 0.72;
    default:
      return 0.8;
  }
}

/**
 * For findings whose correctness depends on the real Dart AST's symbol table
 * (docstrings, extends clauses, class/widget membership) rather than raw
 * file content or import statements: 'ast' when this scan actually had the
 * Dart AST available, 'heuristic_fallback' when this scan fell back to the
 * regex-based symbol extractor. Findings that don't read the symbol table
 * (import-graph, pubspec, filesystem, or pure text-pattern checks) should
 * NOT use this — they're always 'ast' or always 'pattern' regardless of
 * astMeta.source.
 */
export function astOrFallback(astMeta: AstMeta): FindingBasis {
  return astMeta.source === 'dart_analyzer' ? 'ast' : 'heuristic_fallback';
}

function collectRefs(draft: FindingDraft): OfficialReference[] {
  const list: OfficialReference[] = [];
  if (draft.officialReferences) {
    list.push(...draft.officialReferences);
  }
  if (draft.officialReference) {
    list.push(draft.officialReference);
  }
  return list;
}

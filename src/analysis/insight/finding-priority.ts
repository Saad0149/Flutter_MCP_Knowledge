import type { AnalysisFinding } from '../types.js';

/**
 * Single source of truth for a finding's priority. Computed exactly once,
 * here, when a finding is first produced (project-report-builder.ts's merge
 * step) and stored on `AnalysisFinding.priority` — every downstream reader
 * (RecommendationEngine, explain_finding, explore_finding) reads that
 * already-computed value instead of recomputing it.
 *
 * This reconciles what used to be two independently-implemented formulas
 * (project-report-builder.ts's old local deriveFindingPriority and
 * recommendation-engine.ts's derivePriority) that could disagree on the
 * same finding — confirmed reproducible with DebugPrint (confidence 0.95,
 * scoreImpact -4), which used to come back 'medium' via explore_finding and
 * 'high' via explain_finding within the same session.
 */
export function deriveFindingPriority(
  f: AnalysisFinding,
): NonNullable<AnalysisFinding['priority']> {
  if (f.severity === 'info' || f.severity === 'positive') return 'info';
  const impact = Math.abs(f.scoreImpact ?? 0);
  if (impact >= 12 && f.confidence >= 0.9) {
    // A finding that can't cite a single file isn't presentable with 'critical'
    // authority — even at max impact/confidence, it's an aggregate count with
    // nothing to point an agent or developer at. Runs after evidence
    // enrichment, so evidenceItems are already populated here.
    return hasLocatableFileEvidence(f) ? 'critical' : 'high';
  }
  // Reconciled threshold — the union of the two formulas being merged here:
  // "high" when EITHER impact or confidence alone clears its bar (the
  // broader of the two prior rules). A near-certain finding deserves
  // attention even at modest impact, since acting on it is usually cheap
  // and safe.
  if (impact >= 8 || f.confidence >= 0.9) return 'high';
  if (f.severity === 'warning') return 'medium';
  return 'medium';
}

/** Same "does this finding have a real file to point at" check sampleFilesFor uses. */
function hasLocatableFileEvidence(f: AnalysisFinding): boolean {
  if (f.file) return true;
  return (f.evidenceItems ?? []).some((item) => Boolean(item.file));
}

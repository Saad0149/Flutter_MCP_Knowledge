/**
 * Reusable check for the class of bug found in DUPLICATE_FINDINGS_AUDIT.md:
 * two analyzers independently emitting a finding under the same `code`.
 * `code` is meant to be a unique identifier — explore_finding/explain_finding
 * look up a single finding by it — so any duplicate is a bug, never a valid
 * "two sections" case (report.findings is always one merged array; see the
 * audit doc's "why this matters" note).
 *
 * Returns the list of codes that appear more than once, each with its
 * occurrence count — empty when there are no duplicates. Callers assert
 * `toEqual([])` so a regression shows exactly which code(s) collided rather
 * than just "found 2, expected 1".
 */
export interface DuplicateCodeReport {
  readonly code: string;
  readonly count: number;
}

export function findDuplicateFindingCodes(
  findings: readonly { readonly code: string }[],
): readonly DuplicateCodeReport[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([code, count]) => ({ code, count }));
}

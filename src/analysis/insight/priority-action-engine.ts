import { injectable } from 'tsyringe';
import type { AnalysisFinding, PriorityAction } from '../types.js';

const ACTION_DEFS: ReadonlyArray<{
  readonly code: string;
  readonly title: string;
  readonly impact: PriorityAction['impact'];
  readonly effort: PriorityAction['effort'];
  readonly gains: readonly { readonly category: string; readonly delta: number }[];
  readonly rationale: string;
}> = [
  {
    code: 'PresentationImportsData',
    title: 'Remove Presentation → Data imports',
    impact: 'very_high',
    effort: 'high',
    gains: [
      { category: 'Architecture', delta: 12 },
      { category: 'Maintainability', delta: 8 },
    ],
    rationale: 'Restores layer boundaries and unlocks UI testing with fake repositories.',
  },
  {
    code: 'DomainImportsData',
    title: 'Stop Domain → Data imports',
    impact: 'very_high',
    effort: 'high',
    gains: [{ category: 'Architecture', delta: 8 }],
    rationale: 'Keeps domain framework- and IO-agnostic.',
  },
  {
    code: 'CircularDependencies',
    title: 'Break circular imports',
    impact: 'high',
    effort: 'medium',
    gains: [
      { category: 'Maintainability', delta: 8 },
      { category: 'Scalability', delta: 6 },
    ],
    rationale: 'Cycles block feature extraction and make compile order fragile.',
  },
  {
    code: 'HeavySetState',
    title: 'Replace shared/business logic in setState',
    impact: 'medium',
    effort: 'medium',
    gains: [{ category: 'State Management', delta: 7 }],
    rationale: 'Lift cross-widget / network state; keep setState for local UI only.',
  },
  {
    code: 'GodClassCandidate',
    title: 'Split the highest-scoring god classes',
    impact: 'medium',
    effort: 'medium',
    gains: [{ category: 'Code Quality', delta: 6 }],
    rationale: 'Focus on multi-signal god classes first — not every large screen.',
  },
  {
    code: 'LargeBuildMethod',
    title: 'Split the 10 largest build methods',
    impact: 'medium',
    effort: 'medium',
    gains: [
      { category: 'Code Quality', delta: 5 },
      { category: 'Performance', delta: 4 },
    ],
    rationale: 'Extract Header/Body/Actions widgets for the worst offenders.',
  },
  {
    code: 'NoTests',
    title: 'Add tests for repository and domain layers',
    impact: 'high',
    effort: 'high',
    gains: [{ category: 'Testing', delta: 18 }],
    rationale: 'Near-empty test suite is the fastest path to raise testing score.',
  },
  {
    code: 'MultipleStateLibraries',
    title: 'Standardize state approach within mixed features',
    impact: 'medium',
    effort: 'medium',
    gains: [{ category: 'State Management', delta: 6 }],
    rationale: 'Same-feature Riverpod+Bloc mixes hurt readability more than cross-feature coexistence.',
  },
  {
    code: 'DomainImportsFlutter',
    title: 'Remove Flutter imports from Domain',
    impact: 'high',
    effort: 'medium',
    gains: [{ category: 'Architecture', delta: 6 }],
    rationale: 'Enables plain-Dart unit tests for business rules.',
  },
];

/**
 * Turns findings into a prioritized "what to fix first" roadmap.
 */
@injectable()
export class PriorityActionEngine {
  build(findings: readonly AnalysisFinding[], limit = 5): PriorityAction[] {
    const byCode = new Map(findings.map((f) => [f.code, f]));
    const ranked: PriorityAction[] = [];

    for (const def of ACTION_DEFS) {
      const hit = byCode.get(def.code);
      if (!hit) continue;
      if (hit.severity === 'positive') continue;

      ranked.push({
        rank: 0,
        title: def.title,
        findingCode: def.code,
        impact: def.impact,
        effort: def.effort,
        expectedScoreGains: def.gains,
        rationale: def.rationale,
      });
    }

    const impactRank = { very_high: 4, high: 3, medium: 2, low: 1 };
    const effortRank = { low: 3, medium: 2, high: 1 };

    ranked.sort((a, b) => {
      const scoreA =
        impactRank[a.impact] * 10 +
        effortRank[a.effort] +
        a.expectedScoreGains.reduce((s, g) => s + g.delta, 0);
      const scoreB =
        impactRank[b.impact] * 10 +
        effortRank[b.effort] +
        b.expectedScoreGains.reduce((s, g) => s + g.delta, 0);
      return scoreB - scoreA;
    });

    return ranked.slice(0, limit).map((a, idx) => ({ ...a, rank: idx + 1 }));
  }
}

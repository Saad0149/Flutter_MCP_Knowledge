import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import { KnowledgeEngine } from '../knowledge/knowledge-engine.js';
import { FindingRelationshipEngine } from '../relationships/finding-relationship-engine.js';
import type { AnalysisFinding, EvidenceItem, OfficialReference } from '../types.js';
import { deriveFindingPriority } from './finding-priority.js';

export type RecommendationDifficulty = 'low' | 'medium' | 'high';
export type RecommendationPriority = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface FindingRecommendation {
  readonly code: string;
  readonly title: string;
  /** Back-compat fields */
  readonly whyItMatters: string;
  readonly evidence: readonly string[];
  readonly suggestedFix: string | null;
  readonly refactoringStrategy: string;
  readonly expectedImpact: string;
  readonly officialGuidance: string;
  readonly officialReferences: readonly OfficialReference[];
  readonly confidence: number;
  readonly source: AnalysisFinding['source'];
  /** Rich mentor-style fields (v0.6+) */
  readonly problem: string;
  readonly impact: string;
  readonly evidenceItems: readonly EvidenceItem[];
  readonly suggestedRefactor: string;
  readonly expectedBenefits: readonly string[];
  readonly difficulty: RecommendationDifficulty;
  readonly estimatedEffort: string;
  readonly relatedFindings: readonly string[];
  readonly priority: RecommendationPriority;
}

@injectable()
export class RecommendationEngine {
  constructor(
    @inject(TYPES.KnowledgeEngine) private readonly knowledge: KnowledgeEngine,
    @inject(TYPES.FindingRelationshipEngine)
    private readonly relationships: FindingRelationshipEngine,
  ) {}

  recommend(
    findings: readonly AnalysisFinding[],
    allFindings?: readonly AnalysisFinding[],
  ): FindingRecommendation[] {
    const pool = allFindings ?? findings;
    return findings
      .filter((f) => f.severity === 'negative' || f.severity === 'warning')
      .map((f) => this.recommendOne(f, pool));
  }

  explainFinding(
    finding: AnalysisFinding,
    allFindings: readonly AnalysisFinding[] = [],
  ): FindingRecommendation {
    return this.recommendOne(finding, allFindings);
  }

  private recommendOne(
    f: AnalysisFinding,
    all: readonly AnalysisFinding[],
  ): FindingRecommendation {
    const enriched = this.knowledge.enrichFinding(f);
    const officialReferences = [...(enriched.officialReferences ?? [])];
    const hasOfficial = officialReferences.length > 0;
    const related = this.relationships
      .relatedOf(enriched, all)
      .map((r) => r.code)
      .slice(0, 6);

    // Read the finding's own priority — computed exactly once, when the
    // finding was first produced (project-report-builder.ts's merge step)
    // — instead of recomputing it here. The `?? deriveFindingPriority(...)`
    // fallback only matters for a finding that somehow reached this method
    // without going through that step first; it calls the same single
    // source of truth, not a second formula.
    const priority = enriched.priority ?? deriveFindingPriority(enriched);
    const difficulty = deriveDifficulty(enriched);
    const strategy = defaultStrategy(enriched);

    return {
      code: enriched.code,
      title: enriched.title,
      problem: enriched.title,
      whyItMatters:
        enriched.whyItMatters ??
        defaultWhy(enriched) ??
        'This finding was raised from measured project facts and may affect maintainability.',
      impact: defaultImpact(enriched),
      evidence: enriched.evidence,
      evidenceItems: enriched.evidenceItems ?? [],
      suggestedFix: enriched.recommendedFix,
      suggestedRefactor: strategy,
      refactoringStrategy: strategy,
      expectedImpact: defaultImpact(enriched),
      expectedBenefits: defaultBenefits(enriched),
      difficulty,
      estimatedEffort: effortFor(difficulty),
      relatedFindings: related.length > 0 ? related : [...(enriched.relatedFindingCodes ?? [])],
      priority,
      officialGuidance: hasOfficial
        ? 'Official documentation / framework symbols / samples were resolved from the local knowledge index.'
        : 'No official reference was resolved in the local index for this finding; do not invent Flutter rules — verify against flutter.dev / API docs after indexing official repos.',
      officialReferences,
      confidence: enriched.confidence,
      source: enriched.source,
    };
  }
}

function deriveDifficulty(f: AnalysisFinding): RecommendationDifficulty {
  switch (f.code) {
    case 'LegacyButtonApi':
    case 'DebugPrint':
    case 'ConstOpportunities':
    case 'LegacyNewKeywordUsage':
      return 'low';
    case 'GodClassCandidate':
    case 'CircularDependencies':
    case 'PresentationImportsData':
    case 'DomainImportsData':
      return 'high';
    default:
      return 'medium';
  }
}

function effortFor(d: RecommendationDifficulty): string {
  switch (d) {
    case 'low':
      return 'Hours (localized edits)';
    case 'medium':
      return '1–3 days (feature-scoped refactor)';
    case 'high':
      return 'Several days to a sprint (cross-layer redesign)';
  }
}

function defaultWhy(f: AnalysisFinding): string | undefined {
  switch (f.code) {
    case 'PresentationImportsData':
      return 'Presentation becomes coupled to data implementations, reducing testability and the ability to swap storage/network details.';
    case 'DomainImportsFlutter':
      return 'Domain coupled to Flutter cannot be unit-tested as plain Dart and leaks UI concerns into business rules.';
    case 'LogicInWidgets':
      return 'Widgets that own IO become untestable and leak data-layer concerns into presentation.';
    case 'GodClassCandidate':
      return 'Oversized types accumulate unrelated responsibilities and slow safe change.';
    case 'CircularDependencies':
      return 'Import cycles make compile order fragile and block clean feature extraction.';
    default:
      return undefined;
  }
}

function defaultStrategy(f: AnalysisFinding): string {
  switch (f.code) {
    case 'PresentationImportsData':
      return [
        'Suggested architecture:',
        'Presentation → AdminRepository (interface in Domain)',
        'Data → AdminRepositoryImpl implements AdminRepository',
        'Wire implementations at the composition root / DI graph — never import *Impl from UI.',
      ].join('\n');
    case 'DomainImportsData':
    case 'DomainImportsFlutter':
      return 'Extract pure Dart models/use-cases in Domain; push Flutter and IO behind ports owned by Domain, implemented in Data/Infrastructure.';
    case 'LargeBuildMethod':
      return [
        'Suggested split for large build trees:',
        'Screen → Header / Body / Actions / Filters / Summary widgets',
        'Keep build() as composition only; pass data via constructors.',
      ].join('\n');
    case 'GodClassCandidate':
      return 'Split by responsibility (UI sections, state owners, IO). Prefer feature-local widgets/services over a single mega-type.';
    case 'LegacyButtonApi':
      return 'Migrate RaisedButton→ElevatedButton, FlatButton→TextButton, OutlineButton→OutlinedButton.';
    case 'MissingDispose':
      return 'Override State.dispose and dispose every controller/animation/focus node created in initState.';
    case 'LogicInWidgets':
      return 'Move HTTP/Firestore/repository calls into a repository or use-case; widgets dispatch events only.';
    case 'HeavySetState':
      return 'Identify shared mutable state crossing widgets and lift it into a dedicated notifier/bloc/cubit.';
    case 'CircularDependencies':
      return 'Break the cycle by extracting shared types or introducing an interface owned by the higher layer.';
    default:
      return f.recommendedFix
        ? 'Apply the suggested fix incrementally with tests covering the affected feature.'
        : 'Address evidence sites one module at a time; add regression tests before larger moves.';
  }
}

function defaultImpact(f: AnalysisFinding): string {
  const impact = f.scoreImpact ?? 0;
  if (impact <= -10) {
    return 'High: likely improves testability and layer boundaries once fixed.';
  }
  if (impact < 0) {
    return 'Moderate: reduces local risk and improves readability/maintainability.';
  }
  return 'Supports clearer structure; re-run analysis after changes to verify score movement.';
}

function defaultBenefits(f: AnalysisFinding): string[] {
  switch (f.code) {
    case 'PresentationImportsData':
      return [
        'UI becomes independently testable with fake repositories',
        'Data implementations can change without touching screens',
        'Clearer feature ownership across layers',
      ];
    case 'GodClassCandidate':
    case 'LargeBuildMethod':
      return ['Smaller reviewable units', 'Easier rebuild scoping', 'Clearer widget responsibility'];
    case 'HeavySetState':
      return ['Fewer accidental full-tree rebuilds', 'Clearer state ownership', 'Easier widget tests'];
    default:
      return ['Improved maintainability', 'Clearer architecture boundaries'];
  }
}

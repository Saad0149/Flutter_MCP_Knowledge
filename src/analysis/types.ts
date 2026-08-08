/**
 * Shared analysis contracts.
 * Engines compute deterministic facts + findings.
 * MCP tools only expose those results — no review logic in handlers.
 */

export const ENGINE_IDENTITY = 'Flutter Analysis Engine v1.0.0';

export type FindingSeverity = 'positive' | 'negative' | 'info' | 'warning';

export type FindingCategory =
  | 'oop'
  | 'solid'
  | 'dart'
  | 'flutter'
  | 'data_structures'
  | 'state_management'
  | 'architecture'
  | 'testing'
  | 'dependency'
  | 'other';

export type AnalysisSource =
  | 'dart_analyzer'
  | 'heuristic'
  | 'filesystem'
  | 'pubspec'
  | 'import_graph';

export type KnowledgeAuthority = 'official' | 'community' | 'generated';

export interface OfficialReference {
  readonly repository: string;
  readonly file: string;
  readonly line: number | null;
  /** Back-compat optional authority; defaults to official when from knowledge index. */
  readonly authority?: KnowledgeAuthority;
  readonly kind?:
    | 'documentation'
    | 'framework_source'
    | 'widget_test'
    | 'sample'
    | 'migration'
    | 'changelog'
    | 'community'
    | 'other';
  readonly title?: string | null;
  readonly snippet?: string | null;
}

/**
 * Structured evidence — never plain text alone.
 * `evidence: string[]` remains for back-compat summaries.
 */
export interface EvidenceItem {
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly symbol: string | null;
  readonly astNode: string | null;
  readonly analyzer: string;
  readonly confidence: number;
  readonly source: AnalysisSource;
  readonly detail: string;
}

export interface AnalysisFinding {
  readonly severity: FindingSeverity;
  readonly category: FindingCategory;
  readonly code: string;
  readonly title: string;
  readonly description: string;
  /** Back-compat string evidence summaries. */
  readonly evidence: readonly string[];
  readonly recommendedFix: string | null;
  readonly confidence: number;
  readonly source: AnalysisSource;
  readonly whyItMatters?: string;
  readonly scoreImpact?: number;
  readonly file?: string;
  readonly line?: number;
  readonly officialReference?: OfficialReference;
  readonly officialReferences?: readonly OfficialReference[];
  /** Stable id for explore_finding / relationships (added by enrichment). */
  readonly id?: string;
  /** Structured evidence entries (added/enriched by EvidenceEngine). */
  readonly evidenceItems?: readonly EvidenceItem[];
  /** Related finding codes for root-cause navigation. */
  readonly relatedFindingCodes?: readonly string[];
  readonly priority?: 'critical' | 'high' | 'medium' | 'low' | 'info';
}

export interface AstMeta {
  readonly source: 'dart_analyzer' | 'heuristic';
  readonly coverage: 'full' | 'partial' | 'none';
  readonly filesAnalyzed: number;
  readonly filesTotal: number;
  readonly warning?: string;
  readonly baseConfidence: number;
}

export interface AnalysisSummary {
  readonly engine: string;
  readonly astSource: AstMeta['source'];
  readonly coverage: AstMeta['coverage'];
  readonly confidence: number;
  readonly recommendation?: string;
  /**
   * The actual reason the Dart analyzer wasn't used for this run (e.g. the
   * real spawn/exit-code error), verbatim from AstMeta — not a generic
   * "install Dart" message. Undefined when astSource is dart_analyzer.
   */
  readonly warning?: string;
  readonly findingCount: number;
  readonly averageFindingConfidence: number;
}

export interface DartFileInfo {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly lineCount: number;
  readonly content: string;
  readonly imports: readonly string[];
  readonly packageImports: readonly string[];
  readonly relativeImports: readonly string[];
}

export interface SymbolInfo {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly isWidget: boolean;
  readonly docstring: string | null;
  readonly extendsClause: string | null;
  readonly withClause: string | null;
  readonly implementsClause: string | null;
  readonly filePath: string;
}

export interface ProjectSnapshot {
  readonly projectPath: string;
  readonly hasPubspec: boolean;
  readonly pubspecRaw: string | null;
  readonly packageName: string | null;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly isFlutterProject: boolean;
  readonly hasAnalysisOptions: boolean;
  readonly libExists: boolean;
  readonly testExists: boolean;
  readonly topLevelDirs: readonly string[];
  readonly libDirs: readonly string[];
  readonly dartFiles: readonly DartFileInfo[];
  readonly symbols: readonly SymbolInfo[];
  /** file -> imported project-relative dart paths (best-effort) */
  readonly importEdges: readonly { readonly from: string; readonly to: string }[];
  readonly astMeta: AstMeta;
}

export interface AnalyzerResult<TFacts extends object = object> {
  readonly engine: string;
  readonly facts: TFacts;
  readonly findings: readonly AnalysisFinding[];
  readonly astMeta: AstMeta;
}

export interface ProjectAnalysisEngine<TFacts extends object = object> {
  readonly name: string;
  analyze(snapshot: ProjectSnapshot): AnalyzerResult<TFacts> | Promise<AnalyzerResult<TFacts>>;
}

export interface ProjectInsight {
  readonly overview: string;
  readonly architecture: string;
  readonly stateManagement: string;
  readonly codeQuality: string;
  readonly topRisks: readonly string[];
  readonly strengths: readonly string[];
}

export interface ScoreContributor {
  readonly label: string;
  readonly delta: number;
  readonly findingCode?: string;
  readonly evidenceSummary?: string;
}

export interface HealthScore {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly calculation: string;
  readonly inputsUsed: readonly string[];
  /** Transparent score breakdown (v0.6+). */
  readonly positiveContributors?: readonly ScoreContributor[];
  readonly negativeContributors?: readonly ScoreContributor[];
  readonly weight?: number;
  readonly confidence?: number;
  /**
   * True when `value` was floor/ceiling-clamped to [0, max] — i.e. the raw
   * computed value (see `rawValue`) fell outside that range. Present so a
   * clamped 0 or 100 is never mistaken for a precise computed result.
   */
  readonly clamped?: boolean;
  /** The pre-clamp computed value. Only meaningful when `clamped` is true. */
  readonly rawValue?: number;
}

export interface ProjectHealthReport {
  readonly scores: readonly HealthScore[];
  readonly overall: HealthScore;
}

export interface TechnicalDebtItem {
  readonly code: string;
  readonly title: string;
  readonly cost: number;
  readonly count: number;
  readonly findingIds: readonly string[];
}

export interface TechnicalDebtReport {
  readonly debtScore: number;
  readonly max: number;
  readonly confidence: number;
  readonly trend: 'unknown' | 'improving' | 'stable' | 'worsening';
  readonly breakdown: readonly TechnicalDebtItem[];
  readonly highestCostItems: readonly TechnicalDebtItem[];
  readonly majorContributors: readonly string[];
  readonly estimatedRefactoringCost: string;
  readonly estimatedWeeks: { readonly min: number; readonly max: number };
  readonly summary: string;
}

export interface PriorityAction {
  readonly rank: number;
  readonly title: string;
  readonly findingCode: string;
  readonly impact: 'very_high' | 'high' | 'medium' | 'low';
  readonly effort: 'high' | 'medium' | 'low';
  readonly expectedScoreGains: readonly { readonly category: string; readonly delta: number }[];
  readonly rationale: string;
}

export interface ArchitectureMatch {
  readonly architecture: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
}

export interface ProjectHealthSections {
  readonly overview: string;
  readonly architecture: string;
  readonly metrics: string;
  readonly technicalDebt: string;
  readonly topRisks: readonly string[];
  readonly topStrengths: readonly string[];
  readonly topActions: readonly string[];
  readonly categoryScores: readonly HealthScore[];
  readonly confidence: number;
  readonly recommendations: readonly string[];
  readonly trendSummary: string;
  readonly evidenceSummary: string;
}

export interface ProjectMetrics {
  readonly dartFileCount: number;
  readonly libFileCount: number;
  readonly testFileCount: number;
  readonly widgetCount: number;
  readonly classCount: number;
  readonly mixinCount: number;
  readonly extensionCount: number;
  readonly enumCount: number;
  readonly featureCount: number;
  readonly packageDependencyCount: number;
  readonly linesOfCode: number;
  readonly symbolCount: number;
}

/**
 * Clamp confidence to [0, 1] and scale by AST base confidence when the finding
 * depends on symbol/AST quality.
 */
export function withAstConfidence(
  base: number,
  astMeta: AstMeta,
  dependsOnAst: boolean,
): number {
  const clamped = Math.max(0, Math.min(1, base));
  if (!dependsOnAst) {
    return roundConfidence(clamped);
  }
  return roundConfidence(clamped * astMeta.baseConfidence);
}

export function roundConfidence(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
}

export function buildAnalysisSummary(
  astMeta: AstMeta,
  findings: readonly AnalysisFinding[],
): AnalysisSummary {
  const averageFindingConfidence =
    findings.length === 0
      ? astMeta.baseConfidence
      : findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;

  const aggregate = roundConfidence(
    astMeta.baseConfidence * 0.6 + averageFindingConfidence * 0.4,
  );

  const recommendation =
    astMeta.source === 'heuristic'
      ? 'Install the Dart SDK for full-fidelity analysis.'
      : undefined;

  return {
    engine: ENGINE_IDENTITY,
    astSource: astMeta.source,
    coverage: astMeta.coverage,
    confidence: aggregate,
    recommendation,
    warning: astMeta.source === 'heuristic' ? astMeta.warning : undefined,
    findingCount: findings.length,
    averageFindingConfidence: roundConfidence(averageFindingConfidence),
  };
}

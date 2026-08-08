export type {
  AnalysisFinding,
  AnalysisSource,
  AnalysisSummary,
  AnalyzerResult,
  ArchitectureMatch,
  AstMeta,
  EvidenceItem,
  FindingBasis,
  FindingCategory,
  FindingSeverity,
  HealthScore,
  KnowledgeAuthority,
  OfficialReference,
  ProjectAnalysisEngine,
  ProjectHealthReport,
  ProjectHealthSections,
  ProjectInsight,
  ProjectMetrics,
  ProjectSnapshot,
  ScoreContributor,
  TechnicalDebtItem,
  TechnicalDebtReport,
} from './types.js';
export {
  ENGINE_IDENTITY,
  buildAnalysisSummary,
  roundConfidence,
  withAstConfidence,
} from './types.js';
export { ProjectScanner } from './project-scanner.js';
export { OfficialReferenceResolver } from './official-refs.js';
export { AstAdapter } from './ast/ast-adapter.js';
export { CodeQualityAnalyzer } from './engines/code-quality-analyzer.js';
export type { CodeQualityFacts } from './engines/code-quality-analyzer.js';
export { StateManagementAnalyzer } from './engines/state-management-analyzer.js';
export type {
  DetectedStateApproach,
  StateManagementFacts,
} from './engines/state-management-analyzer.js';
export { ArchitectureAnalyzer } from './engines/architecture-analyzer.js';
export type {
  ArchitectureFacts,
  DetectedArchitecture,
} from './engines/architecture-analyzer.js';
export { ArchitectureMatchEngine } from './engines/architecture-match-engine.js';
export { MetricsEngine } from './metrics/metrics-engine.js';
export { ExplanationEngine } from './insight/explanation-engine.js';
export type { FindingExplanation } from './insight/explanation-engine.js';
export { RecommendationEngine } from './insight/recommendation-engine.js';
export type {
  FindingRecommendation,
  RecommendationDifficulty,
  RecommendationPriority,
} from './insight/recommendation-engine.js';
export { ProjectHealthScorer } from './insight/project-health-scorer.js';
export { IntendedBehaviourEngine } from './insight/intended-behaviour-engine.js';
export type {
  IntendedBehaviourHit,
  IntendedBehaviourResult,
} from './insight/intended-behaviour-engine.js';
export { RuleEngine } from './rules/rule-engine.js';
export type { AnalysisRule } from './rules/rule-engine.js';
export { registerBuiltinAnalyzers } from './rules/register-builtin.js';
export { PriorityActionEngine } from './insight/priority-action-engine.js';
export { ProjectReportBuilder } from './insight/project-report-builder.js';
export type { ProjectAnalysisReport } from './insight/project-report-builder.js';
export type { PriorityAction } from './types.js';
export { AnalysisSessionStore } from './session/analysis-session-store.js';
export type { StoredAnalysisSession } from './session/analysis-session-store.js';
export {
  buildReviewSummary,
  filterFindingsByCategory,
  toFindingCard,
  toScoreCard,
} from './session/summary-views.js';
export type {
  FindingCard,
  ReviewProjectSummary,
  ScoreCard,
} from './session/summary-views.js';
export { EvidenceEngine } from './evidence/evidence-engine.js';
export { KnowledgeEngine } from './knowledge/knowledge-engine.js';
export { ScoringEngine } from './scoring/scoring-engine.js';
export { TechnicalDebtEngine } from './debt/technical-debt-engine.js';
export { FindingRelationshipEngine } from './relationships/finding-relationship-engine.js';
export { ComplexityAnalyzer } from './engines/complexity-analyzer.js';
export type { ComplexityFacts } from './engines/complexity-analyzer.js';
export { TestingAnalyzer } from './engines/testing-analyzer.js';
export type { TestingAnalyzerFacts } from './engines/testing-analyzer.js';
export { DependencyAnalyzer } from './engines/dependency-analyzer.js';
export type { DependencyFacts, LayerViolation } from './engines/dependency-analyzer.js';
export { PerformanceAnalyzer } from './engines/performance-analyzer.js';
export type { PerformanceFacts } from './engines/performance-analyzer.js';
export { DocumentationAnalyzer } from './engines/documentation-analyzer.js';
export type { DocumentationFacts } from './engines/documentation-analyzer.js';
export { AccessibilityAnalyzer } from './engines/accessibility-analyzer.js';
export type { AccessibilityFacts } from './engines/accessibility-analyzer.js';

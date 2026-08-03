import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import type { AccessibilityFacts } from '../engines/accessibility-analyzer.js';
import type { ArchitectureFacts } from '../engines/architecture-analyzer.js';
import type { CodeQualityFacts } from '../engines/code-quality-analyzer.js';
import type { ComplexityFacts } from '../engines/complexity-analyzer.js';
import type { DependencyFacts } from '../engines/dependency-analyzer.js';
import type { DocumentationFacts } from '../engines/documentation-analyzer.js';
import type { PerformanceFacts } from '../engines/performance-analyzer.js';
import type { StateManagementFacts } from '../engines/state-management-analyzer.js';
import type { TestingAnalyzerFacts } from '../engines/testing-analyzer.js';
import { ScoringEngine } from '../scoring/scoring-engine.js';
import type {
  AnalysisFinding,
  ProjectHealthReport,
  ProjectMetrics,
  ProjectSnapshot,
} from '../types.js';

/**
 * Back-compat facade — delegates to ScoringEngine for transparent contributors.
 * New analyzer facts are optional to preserve backward compatibility.
 */
@injectable()
export class ProjectHealthScorer {
  constructor(@inject(TYPES.ScoringEngine) private readonly scoring: ScoringEngine) {}

  score(input: {
    readonly snapshot: ProjectSnapshot;
    readonly metrics: ProjectMetrics;
    readonly findings: readonly AnalysisFinding[];
    readonly architecture: ArchitectureFacts;
    readonly codeQuality: CodeQualityFacts;
    readonly stateManagement: StateManagementFacts;
    readonly complexity?: ComplexityFacts;
    readonly testing?: TestingAnalyzerFacts;
    readonly dependency?: DependencyFacts;
    readonly performance?: PerformanceFacts;
    readonly documentation?: DocumentationFacts;
    readonly accessibility?: AccessibilityFacts;
  }): ProjectHealthReport {
    return this.scoring.score(input);
  }
}

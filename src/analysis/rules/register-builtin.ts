import type { AccessibilityAnalyzer } from '../engines/accessibility-analyzer.js';
import type { ArchitectureAnalyzer } from '../engines/architecture-analyzer.js';
import type { CodeQualityAnalyzer } from '../engines/code-quality-analyzer.js';
import type { ComplexityAnalyzer } from '../engines/complexity-analyzer.js';
import type { DependencyAnalyzer } from '../engines/dependency-analyzer.js';
import type { DocumentationAnalyzer } from '../engines/documentation-analyzer.js';
import type { PerformanceAnalyzer } from '../engines/performance-analyzer.js';
import type { StateManagementAnalyzer } from '../engines/state-management-analyzer.js';
import type { TestingAnalyzer } from '../engines/testing-analyzer.js';
import type { AnalysisRule } from './rule-engine.js';
import type { RuleEngine } from './rule-engine.js';

/**
 * Registers the built-in analyzer engines as rule packs on a RuleEngine.
 * Order matters: architecture and dependency are registered first so their
 * findings can be referenced by later analyzers.
 */
export function registerBuiltinAnalyzers(
  ruleEngine: RuleEngine,
  analyzers: {
    readonly codeQuality: CodeQualityAnalyzer;
    readonly stateManagement: StateManagementAnalyzer;
    readonly architecture: ArchitectureAnalyzer;
    readonly complexity?: ComplexityAnalyzer;
    readonly testing?: TestingAnalyzer;
    readonly dependency?: DependencyAnalyzer;
    readonly performance?: PerformanceAnalyzer;
    readonly documentation?: DocumentationAnalyzer;
    readonly accessibility?: AccessibilityAnalyzer;
  },
): void {
  const packs: AnalysisRule[] = [
    {
      id: 'code_quality',
      categories: ['oop', 'solid', 'dart', 'flutter', 'data_structures'],
      evaluate: (snapshot) => analyzers.codeQuality.analyze(snapshot).findings,
    },
    {
      id: 'state_management',
      categories: ['state_management'],
      evaluate: (snapshot) => analyzers.stateManagement.analyze(snapshot).findings,
    },
    {
      id: 'architecture',
      categories: ['architecture', 'dependency', 'testing'],
      evaluate: (snapshot) => analyzers.architecture.analyze(snapshot).findings,
    },
  ];

  if (analyzers.complexity) {
    const complexity = analyzers.complexity;
    packs.push({
      id: 'complexity',
      categories: ['flutter', 'dart'],
      evaluate: (snapshot) => complexity.analyze(snapshot).findings,
    });
  }

  if (analyzers.testing) {
    const testing = analyzers.testing;
    packs.push({
      id: 'testing',
      categories: ['testing'],
      evaluate: (snapshot) => testing.analyze(snapshot).findings,
    });
  }

  if (analyzers.dependency) {
    const dependency = analyzers.dependency;
    packs.push({
      id: 'dependency',
      categories: ['dependency', 'architecture'],
      evaluate: (snapshot) => dependency.analyze(snapshot).findings,
    });
  }

  if (analyzers.performance) {
    const performance = analyzers.performance;
    packs.push({
      id: 'performance',
      categories: ['flutter'],
      evaluate: (snapshot) => performance.analyze(snapshot).findings,
    });
  }

  if (analyzers.documentation) {
    const documentation = analyzers.documentation;
    packs.push({
      id: 'documentation',
      categories: ['dart', 'flutter', 'other'],
      evaluate: (snapshot) => documentation.analyze(snapshot).findings,
    });
  }

  if (analyzers.accessibility) {
    const accessibility = analyzers.accessibility;
    packs.push({
      id: 'accessibility',
      categories: ['flutter'],
      evaluate: (snapshot) => accessibility.analyze(snapshot).findings,
    });
  }

  for (const pack of packs) {
    if (!ruleEngine.list().some((r) => r.id === pack.id)) {
      ruleEngine.register(pack);
    }
  }
}

import { describe, expect, it } from 'vitest';
import { buildReviewSummary } from '../../../src/analysis/session/summary-views.js';
import type { ProjectAnalysisReport } from '../../../src/analysis/insight/project-report-builder.js';

function fakeReport(
  astSource: 'dart_analyzer' | 'heuristic',
  coverage: 'full' | 'partial' | 'none',
  warning?: string,
): Omit<ProjectAnalysisReport, 'snapshot'> {
  return {
    projectPath: '/tmp/project',
    analysisSummary: {
      engine: 'Flutter Analysis Engine v0.7.0',
      astSource,
      coverage,
      confidence: 0.9,
      warning,
      findingCount: 0,
      averageFindingConfidence: 0.9,
    },
    insight: { overview: 'Overview text.', architecture: '', strengths: [], topRisks: [] },
    health: {
      overall: { id: 'overall', label: 'Overall', value: 80, max: 100 },
      scores: [],
    },
    healthReport: {
      overview: 'Overview text.',
      architecture: '',
      metrics: '',
      technicalDebt: '',
      topRisks: [],
      topStrengths: [],
      topActions: [],
      categoryScores: [],
      confidence: 0.9,
      recommendations: [],
      trendSummary: '',
      evidenceSummary: '',
    },
    metrics: {} as ProjectAnalysisReport['metrics'],
    technicalDebt: { debtScore: 10, estimatedRefactoringCost: '1 day', majorContributors: [] },
    topActions: [],
    architectureDetection: {} as ProjectAnalysisReport['architectureDetection'],
    recommendations: [],
    results: {} as ProjectAnalysisReport['results'],
    findings: [],
  } as unknown as Omit<ProjectAnalysisReport, 'snapshot'>;
}

describe('buildReviewSummary fidelity notice', () => {
  it('omits fidelityNotice when AST source is dart_analyzer with full coverage', () => {
    const summary = buildReviewSummary('session-1', fakeReport('dart_analyzer', 'full'));
    expect(summary.fidelityNotice).toBeUndefined();
  });

  it('sets a prominent fidelityNotice pointing at check_environment when heuristic', () => {
    const summary = buildReviewSummary('session-2', fakeReport('heuristic', 'partial'));
    expect(summary.fidelityNotice).toBeDefined();
    expect(summary.fidelityNotice).toContain('check_environment');
    expect(summary.fidelityNotice).toContain('heuristic');
  });

  it('sets fidelityNotice when AST source is dart_analyzer but coverage is only partial', () => {
    const summary = buildReviewSummary('session-3', fakeReport('dart_analyzer', 'partial'));
    expect(summary.fidelityNotice).toBeDefined();
    expect(summary.fidelityNotice).toContain('check_environment');
  });

  it('includes the real underlying warning verbatim, not just the generic recommendation', () => {
    const summary = buildReviewSummary(
      'session-4',
      fakeReport(
        'heuristic',
        'partial',
        'dart helper exited with code 1: Because flutter_knowledge_parser depends on analyzer...',
      ),
    );
    expect(summary.fidelityNotice).toBeDefined();
    expect(summary.fidelityNotice).toContain('Reason:');
    expect(summary.fidelityNotice).toContain('flutter_knowledge_parser');
  });
});

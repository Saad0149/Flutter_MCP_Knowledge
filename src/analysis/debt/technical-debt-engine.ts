import { injectable } from 'tsyringe';
import type { ArchitectureFacts } from '../engines/architecture-analyzer.js';
import type { CodeQualityFacts } from '../engines/code-quality-analyzer.js';
import type { StateManagementFacts } from '../engines/state-management-analyzer.js';
import type { AnalysisFinding, TechnicalDebtItem, TechnicalDebtReport } from '../types.js';

@injectable()
export class TechnicalDebtEngine {
  calculate(input: {
    readonly findings: readonly AnalysisFinding[];
    readonly architecture: ArchitectureFacts;
    readonly codeQuality: CodeQualityFacts;
    readonly stateManagement: StateManagementFacts;
  }): TechnicalDebtReport {
    const items: TechnicalDebtItem[] = [];

    pushCount(
      items,
      input.findings,
      'GodClassCandidate',
      input.codeQuality.godClassDetails?.length ?? input.codeQuality.godClassCandidates.length,
      8,
      'God classes (multi-signal)',
    );
    pushCount(
      items,
      input.findings,
      'LargeClassCandidate',
      input.codeQuality.largeClassCandidates?.length ?? 0,
      1,
      'Large class candidates (size only)',
    );
    pushCount(
      items,
      input.findings,
      'LargeBuildMethod',
      input.codeQuality.largeBuildMethods.length,
      4,
      'Large build methods',
    );
    pushCount(
      items,
      input.findings,
      'CircularDependencies',
      input.architecture.circularDependencies.length,
      10,
      'Circular imports',
    );

    const layerViolations =
      Number(input.architecture.presentationImportsData) +
      Number(input.architecture.domainImportsData) +
      Number(input.architecture.domainImportsFlutter);
    if (layerViolations > 0) {
      items.push({
        code: 'LayerViolations',
        title: 'Layer violations',
        cost: layerViolations * 15,
        count: layerViolations,
        findingIds: input.findings
          .filter((f) =>
            ['PresentationImportsData', 'DomainImportsData', 'DomainImportsFlutter'].includes(
              f.code,
            ),
          )
          .map((f) => f.id ?? f.code),
      });
    }

    const problematicSetState = input.stateManagement.problematicSetStateSites ?? 0;
    if (problematicSetState > 10) {
      items.push({
        code: 'HeavySetState',
        title: 'Problematic setState (shared/business/network)',
        cost: Math.min(35, Math.floor(problematicSetState / 4)),
        count: problematicSetState,
        findingIds: input.findings.filter((f) => f.code === 'HeavySetState').map((f) => f.id ?? f.code),
      });
    }

    if (input.codeQuality.undocumentedWidgets > 10) {
      items.push({
        code: 'UndocumentedWidgets',
        title: 'Documentation gaps',
        cost: Math.min(15, Math.floor(input.codeQuality.undocumentedWidgets / 8)),
        count: input.codeQuality.undocumentedWidgets,
        findingIds: input.findings
          .filter((f) => f.code === 'UndocumentedWidgets')
          .map((f) => f.id ?? f.code),
      });
    }

    if (input.architecture.testFileCount <= 1) {
      items.push({
        code: 'NoTests',
        title: 'Near-absent automated tests',
        cost: 25,
        count: Math.max(1, input.architecture.testFileCount),
        findingIds: input.findings.filter((f) => f.code === 'NoTests').map((f) => f.id ?? f.code),
      });
    }

    const debtScore = Math.min(
      100,
      items.reduce((sum, i) => sum + i.cost, 0),
    );
    const sorted = [...items].sort((a, b) => b.cost - a.cost);
    const confidence = averageConfidence(input.findings);
    const weeks = estimateWeeks(debtScore, sorted);
    const majorContributors = sorted.slice(0, 6).map((i) => `${i.count} ${i.title}`);

    return {
      debtScore,
      max: 100,
      confidence,
      trend: 'unknown',
      breakdown: sorted,
      highestCostItems: sorted.slice(0, 5),
      majorContributors,
      estimatedWeeks: weeks,
      estimatedRefactoringCost: `${weeks.min}–${weeks.max} weeks`,
      summary:
        sorted.length === 0
          ? 'No significant technical debt contributors detected from current rules.'
          : `Technical debt ${debtScore}/100. Major contributors: ${majorContributors.join('; ')}. Estimated refactoring cost: ${weeks.min}–${weeks.max} weeks.`,
    };
  }
}

function estimateWeeks(
  debtScore: number,
  items: readonly TechnicalDebtItem[],
): { min: number; max: number } {
  const base = debtScore / 30;
  const layerHeavy = items.some((i) => i.code === 'LayerViolations' || i.code === 'CircularDependencies');
  const min = Math.max(1, Math.round(base * (layerHeavy ? 1.2 : 1)));
  const max = Math.max(min + 1, Math.round(base * (layerHeavy ? 2.2 : 1.8)));
  return { min, max };
}

function pushCount(
  items: TechnicalDebtItem[],
  findings: readonly AnalysisFinding[],
  code: string,
  count: number,
  unitCost: number,
  title: string,
): void {
  if (count <= 0) return;
  items.push({
    code,
    title,
    cost: Math.min(50, Math.ceil(Math.log2(count + 1) * unitCost)),
    count,
    findingIds: findings.filter((f) => f.code === code).map((f) => f.id ?? f.code),
  });
}

function averageConfidence(findings: readonly AnalysisFinding[]): number {
  const relevant = findings.filter(
    (f) => f.severity === 'negative' || f.severity === 'warning',
  );
  if (relevant.length === 0) return 0.8;
  return (
    Math.round(
      (relevant.reduce((s, f) => s + f.confidence, 0) / relevant.length) * 1000,
    ) / 1000
  );
}

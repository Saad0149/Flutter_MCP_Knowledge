import { injectable } from 'tsyringe';
import type { AnalysisFinding } from '../types.js';

const RELATION_MAP: Readonly<Record<string, readonly string[]>> = {
  PresentationImportsData: [
    'DomainImportsData',
    'CircularDependencies',
    'LogicInWidgets',
    'CleanLayerBoundaries',
  ],
  DomainImportsData: ['PresentationImportsData', 'DomainImportsFlutter', 'CircularDependencies'],
  DomainImportsFlutter: ['DomainImportsData', 'PresentationImportsData'],
  CircularDependencies: ['PresentationImportsData', 'DomainImportsData', 'FeatureIsolationFolders'],
  GodClassCandidate: ['LargeBuildMethod', 'LogicInWidgets', 'UndocumentedWidgets'],
  LargeBuildMethod: ['GodClassCandidate', 'ConstOpportunities', 'HeavySetState'],
  HeavySetState: ['LogicInWidgets', 'MultipleStateLibraries', 'ModestSetState'],
  LogicInWidgets: ['PresentationImportsData', 'HeavySetState', 'MissingDispose'],
  MissingDispose: ['HasDisposeMethods', 'LogicInWidgets'],
  LegacyButtonApi: ['ConstOpportunities', 'DebugPrint'],
  MultipleStateLibraries: ['HeavySetState', 'DetectedApproaches'],
  NoTests: ['HasTests', 'Assessments'],
};

@injectable()
export class FindingRelationshipEngine {
  relate(findings: readonly AnalysisFinding[]): AnalysisFinding[] {
    const present = new Set(findings.map((f) => f.code));
    return findings.map((f) => {
      const suggested = RELATION_MAP[f.code] ?? [];
      const related = [
        ...suggested,
        ...findings
          .filter(
            (other) =>
              other.code !== f.code &&
              other.category === f.category &&
              (other.severity === 'negative' || other.severity === 'warning'),
          )
          .map((other) => other.code),
      ];
      const unique = [...new Set(related)].filter((code) => code !== f.code).slice(0, 8);
      // Prefer currently active related findings first in ordering
      const ordered = [
        ...unique.filter((c) => present.has(c)),
        ...unique.filter((c) => !present.has(c)),
      ];
      return {
        ...f,
        relatedFindingCodes: ordered.slice(0, 8),
      };
    });
  }

  relatedOf(finding: AnalysisFinding, all: readonly AnalysisFinding[]): AnalysisFinding[] {
    const codes = new Set(finding.relatedFindingCodes ?? RELATION_MAP[finding.code] ?? []);
    return all.filter((f) => codes.has(f.code) && f.code !== finding.code);
  }
}

import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import { OfficialReferenceResolver } from '../official-refs.js';
import type {
  AnalysisFinding,
  AnalyzerResult,
  ProjectAnalysisEngine,
  ProjectSnapshot,
} from '../types.js';
import { detectCycles } from './detect-cycles.js';
import { finding } from './finding-factory.js';

export type DetectedArchitecture =
  | 'clean_architecture'
  | 'feature_first'
  | 'layered'
  | 'mvvm'
  | 'mvc'
  | 'modular'
  | 'package_by_feature'
  | 'package_by_layer'
  | 'vertical_slice'
  | 'hybrid'
  | 'custom'
  | 'unknown';

export interface ArchitectureFacts {
  readonly detectedArchitecture: DetectedArchitecture;
  readonly confidence: number;
  readonly libDirs: readonly string[];
  readonly featureDirCount: number;
  readonly hasDomain: boolean;
  readonly hasData: boolean;
  readonly hasPresentation: boolean;
  readonly hasCore: boolean;
  readonly hasShared: boolean;
  readonly hasFeatures: boolean;
  readonly presentationImportsData: boolean;
  readonly domainImportsFlutter: boolean;
  readonly domainImportsData: boolean;
  readonly circularDependencies: readonly string[];
  readonly testFileCount: number;
  readonly libFileCount: number;
  readonly dependencyDirectionSummary: string;
  readonly evidence: readonly string[];
  readonly maintainabilityScore: number;
  readonly scalabilityScore: number;
}

@injectable()
export class ArchitectureAnalyzer implements ProjectAnalysisEngine<ArchitectureFacts> {
  readonly name = 'architecture';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<ArchitectureFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;
    const libDirsLower = snapshot.libDirs.map((d) => d.toLowerCase());
    const allLibPaths = snapshot.dartFiles
      .filter((f) => f.relativePath.startsWith('lib/'))
      .map((f) => f.relativePath.toLowerCase());

    const hasDomain =
      libDirsLower.includes('domain') || allLibPaths.some((p) => p.includes('/domain/'));
    const hasData = libDirsLower.includes('data') || allLibPaths.some((p) => p.includes('/data/'));
    const hasPresentation =
      libDirsLower.includes('presentation') ||
      libDirsLower.includes('ui') ||
      libDirsLower.includes('views') ||
      allLibPaths.some((p) => /\/(presentation|ui|views)\//.test(p));
    const hasCore = libDirsLower.includes('core') || allLibPaths.some((p) => p.includes('/core/'));
    const hasShared =
      libDirsLower.includes('shared') ||
      libDirsLower.includes('common') ||
      allLibPaths.some((p) => /\/(shared|common)\//.test(p));
    const hasFeatures =
      libDirsLower.includes('features') ||
      libDirsLower.includes('feature') ||
      allLibPaths.some((p) => p.includes('/features/'));

    const featureDirCount = countFeatureDirs(snapshot);

    let presentationImportsData = false;
    let domainImportsFlutter = false;
    let domainImportsData = false;

    for (const file of snapshot.dartFiles) {
      const pathLower = file.relativePath.toLowerCase();
      const isPresentation = /\/(presentation|ui|views|screens|pages|widgets)\//.test(pathLower);
      const isDomain = pathLower.includes('/domain/');

      for (const imp of file.imports) {
        const impLower = imp.toLowerCase();
        if (isPresentation && (impLower.includes('/data/') || impLower.includes('repository_impl'))) {
          presentationImportsData = true;
        }
        if (isDomain && (impLower.startsWith('package:flutter/') || impLower === 'package:flutter')) {
          domainImportsFlutter = true;
        }
        if (isDomain && impLower.includes('/data/')) {
          domainImportsData = true;
        }
      }
    }

    const circularDependencies = detectCycles(snapshot.importEdges).slice(0, 20);

    const evidence: string[] = [
      `libDirs=${snapshot.libDirs.join(',') || '(none)'}`,
      `hasDomain=${hasDomain}`,
      `hasData=${hasData}`,
      `hasPresentation=${hasPresentation}`,
      `hasFeatures=${hasFeatures}`,
      `hasCore=${hasCore}`,
      `hasShared=${hasShared}`,
      `featureDirCount=${featureDirCount}`,
      `presentationImportsData=${presentationImportsData}`,
      `domainImportsFlutter=${domainImportsFlutter}`,
      `domainImportsData=${domainImportsData}`,
      `circularDependencies=${circularDependencies.length}`,
    ];

    const { architecture, confidence } = classifyArchitecture({
      hasDomain,
      hasData,
      hasPresentation,
      hasFeatures,
      hasCore,
      featureDirCount,
      presentationImportsData,
      domainImportsFlutter,
      domainImportsData,
    });

    let dependencyDirectionSummary = 'undetermined';
    if (hasPresentation && hasDomain && hasData) {
      dependencyDirectionSummary = presentationImportsData
        ? 'Presentation appears to reach Data directly (layer leak)'
        : domainImportsData
          ? 'Domain appears to import Data (layer leak)'
          : 'Likely Presentation -> Domain <- Data (clean-ish)';
    } else if (hasFeatures) {
      dependencyDirectionSummary = 'Feature-oriented modules (check cross-feature imports)';
    }

    const testFileCount = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('test/')).length;
    const libFileCount = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('lib/')).length;

    const maintainabilityScore = clamp(
      70 +
        (hasDomain && hasData && hasPresentation ? 10 : 0) +
        (hasFeatures ? 5 : 0) -
        (presentationImportsData ? 15 : 0) -
        (domainImportsFlutter ? 10 : 0) -
        (circularDependencies.length > 0 ? 15 : 0) -
        (testFileCount === 0 ? 10 : 0),
    );
    const scalabilityScore = clamp(
      65 +
        (hasFeatures ? 15 : 0) +
        (hasCore || hasShared ? 5 : 0) +
        (architecture === 'clean_architecture' || architecture === 'feature_first' ? 10 : 0) -
        (circularDependencies.length > 0 ? 20 : 0) -
        (presentationImportsData ? 10 : 0),
    );

    const facts: ArchitectureFacts = {
      detectedArchitecture: architecture,
      confidence,
      libDirs: snapshot.libDirs,
      featureDirCount,
      hasDomain,
      hasData,
      hasPresentation,
      hasCore,
      hasShared,
      hasFeatures,
      presentationImportsData,
      domainImportsFlutter,
      domainImportsData,
      circularDependencies,
      testFileCount,
      libFileCount,
      dependencyDirectionSummary,
      evidence,
      maintainabilityScore,
      scalabilityScore,
    };

    findings.push(
      finding(
        {
          severity: 'info',
          category: 'architecture',
          code: 'DetectedArchitecture',
          title: `Detected architecture: ${architecture}`,
          description: `Confidence ${confidence}% based on folder layout and import facts (not a guess).`,
          evidence,
          recommendedFix: null,
          officialReference: this.refs.lookupDoc('app architecture'),
          source: 'filesystem',
          confidence: confidence / 100,
          basis: 'ast',
          whyItMatters:
            'Knowing the dominant structure tells you where features belong and which dependency rules to enforce.',
        },
        ast,
      ),
    );

    if (hasDomain && hasData && hasPresentation && !presentationImportsData && !domainImportsData) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'architecture',
            code: 'CleanLayerBoundaries',
            title: 'Layer folders present without obvious Presentation→Data / Domain→Data imports',
            description:
              'Folder structure suggests layered/clean separation with healthy dependency direction.',
            evidence: [
              'domain/data/presentation (or ui) present',
              `dependencyDirection=${dependencyDirectionSummary}`,
            ],
            recommendedFix: null,
            source: 'import_graph',
            confidence: 0.92,
            basis: 'ast',
            scoreImpact: 10,
          },
          ast,
        ),
      );
    }

    if (presentationImportsData) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'architecture',
            code: 'PresentationImportsData',
            title: 'Presentation imports Data',
            description:
              'Presentation should depend on Domain abstractions, not Data implementations.',
            evidence: ['At least one presentation/ui/views file imports a data-layer path'],
            recommendedFix: 'Depend on repository interfaces in Domain; inject Data implementations.',
            officialReference: this.refs.lookupDoc('clean architecture'),
            source: 'import_graph',
            confidence: 1,
            basis: 'ast',
            scoreImpact: -15,
            whyItMatters:
              'UI depending on data implementations couples screens to storage/network details and blocks independent testing.',
          },
          ast,
        ),
      );
    }

    if (domainImportsFlutter) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'architecture',
            code: 'DomainImportsFlutter',
            title: 'Domain imports Flutter',
            description:
              'Domain layer should stay framework-agnostic when pursuing Clean Architecture.',
            evidence: ['Domain file imports package:flutter'],
            recommendedFix: 'Keep Flutter widgets/types out of domain; use plain Dart models/use-cases.',
            source: 'import_graph',
            confidence: 1,
            basis: 'ast',
            scoreImpact: -12,
            whyItMatters:
              'A Flutter-coupled domain cannot be reused or unit-tested without a widget binding.',
          },
          ast,
        ),
      );
    }

    if (domainImportsData) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'architecture',
            code: 'DomainImportsData',
            title: 'Domain imports Data',
            description: 'Dependency rule violated: Domain must not depend on Data.',
            evidence: ['Domain file imports a data-layer path'],
            recommendedFix: 'Invert dependency via repository interfaces owned by Domain.',
            source: 'import_graph',
            confidence: 1,
            basis: 'ast',
            scoreImpact: -15,
          },
          ast,
        ),
      );
    }

    // NOTE: circular-import detection intentionally does NOT emit a finding
    // here. DependencyAnalyzer owns the 'CircularDependencies' finding
    // (dynamic count-based title) — both analyzers used to run their own
    // copy-pasted cycle detector over the same `snapshot.importEdges` (see
    // DUPLICATE_FINDINGS_AUDIT.md #5; the two implementations now share one
    // function, detectCycles() in detect-cycles.ts). `circularDependencies`
    // is still computed and exposed via `facts` for this analyzer's own
    // architecture/scalability scoring.

    if (hasFeatures && featureDirCount >= 2) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'architecture',
            code: 'FeatureIsolationFolders',
            title: 'Feature-first folder structure',
            description: 'Multiple feature directories improve discoverability and ownership.',
            evidence: [`featureDirCount=${featureDirCount}`, `libDirs=${snapshot.libDirs.join(',')}`],
            recommendedFix: null,
            source: 'filesystem',
            confidence: 0.95,
            basis: 'ast',
            scoreImpact: 8,
          },
          ast,
        ),
      );
    }

    if (!snapshot.libExists) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'architecture',
            code: 'NoLibFolder',
            title: 'No lib/ directory',
            description: 'Standard Flutter/Dart packages place application code under lib/.',
            evidence: ['lib/ missing'],
            recommendedFix: 'Create lib/ and move application sources there.',
            source: 'filesystem',
            confidence: 1,
            basis: 'ast',
            scoreImpact: -10,
          },
          ast,
        ),
      );
    }

    if (testFileCount === 0 && libFileCount > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'testing',
            code: 'NoTests',
            title: 'No tests detected under test/',
            description: 'Automated tests improve maintainability of architecture boundaries.',
            evidence: [`libFileCount=${libFileCount}`, 'test/ dart files=0'],
            recommendedFix: 'Add widget/unit/golden tests mirroring features.',
            officialReference: this.refs.lookupDoc('testing'),
            source: 'filesystem',
            confidence: 0.95,
            basis: 'ast',
            scoreImpact: -10,
          },
          ast,
        ),
      );
    } else if (testFileCount > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'testing',
            code: 'HasTests',
            title: 'Test suite present',
            description: 'Found Dart files under test/.',
            evidence: [`testFileCount=${testFileCount}`],
            recommendedFix: null,
            source: 'filesystem',
            confidence: 0.95,
            basis: 'ast',
            scoreImpact: 8,
          },
          ast,
        ),
      );
    }

    findings.push(
      finding(
        {
          severity: 'info',
          category: 'architecture',
          code: 'Assessments',
          title: 'Maintainability and scalability assessments',
          description: 'Scores derived from measured architectural facts.',
          evidence: [
            `maintainability=${maintainabilityScore}`,
            `scalability=${scalabilityScore}`,
            `dependencyDirection=${dependencyDirectionSummary}`,
          ],
          recommendedFix: null,
          source: 'filesystem',
          confidence: 0.85,
          basis: 'ast',
        },
        ast,
      ),
    );

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

function countFeatureDirs(snapshot: ProjectSnapshot): number {
  const featuresRoot = snapshot.libDirs.find(
    (d) => d.toLowerCase() === 'features' || d.toLowerCase() === 'feature',
  );
  if (!featuresRoot) {
    return snapshot.libDirs.filter(
      (d) =>
        !['core', 'shared', 'common', 'domain', 'data', 'presentation', 'ui', 'l10n'].includes(
          d.toLowerCase(),
        ),
    ).length;
  }
  const names = new Set<string>();
  for (const file of snapshot.dartFiles) {
    const m = /lib\/features\/([^/]+)\//i.exec(file.relativePath.replaceAll('\\', '/'));
    if (m?.[1]) names.add(m[1]);
  }
  return names.size;
}

function classifyArchitecture(input: {
  hasDomain: boolean;
  hasData: boolean;
  hasPresentation: boolean;
  hasFeatures: boolean;
  hasCore: boolean;
  featureDirCount: number;
  presentationImportsData: boolean;
  domainImportsFlutter: boolean;
  domainImportsData: boolean;
}): { architecture: DetectedArchitecture; confidence: number } {
  const cleanSignals =
    Number(input.hasDomain) + Number(input.hasData) + Number(input.hasPresentation);
  const cleanViolations =
    Number(input.presentationImportsData) +
    Number(input.domainImportsFlutter) +
    Number(input.domainImportsData);

  if (cleanSignals === 3 && cleanViolations === 0) {
    return {
      architecture: input.hasFeatures ? 'hybrid' : 'clean_architecture',
      confidence: input.hasFeatures ? 75 : 85,
    };
  }
  if (cleanSignals === 3 && cleanViolations > 0) {
    return { architecture: 'layered', confidence: 70 };
  }
  if (input.hasFeatures && input.featureDirCount >= 2) {
    return { architecture: 'feature_first', confidence: 80 };
  }
  if (input.hasCore && (input.hasPresentation || input.hasData)) {
    return { architecture: 'layered', confidence: 60 };
  }
  if (cleanSignals >= 2) {
    return { architecture: 'layered', confidence: 55 };
  }
  if (input.hasFeatures) {
    return { architecture: 'package_by_feature', confidence: 50 };
  }
  return { architecture: 'unknown', confidence: 30 };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

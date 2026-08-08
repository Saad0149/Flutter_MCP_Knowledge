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

export interface LayerViolation {
  readonly from: string;
  readonly to: string;
  readonly rule: string;
}

export interface DependencyFacts {
  readonly totalEdges: number;
  readonly totalNodes: number;
  readonly layerViolations: readonly LayerViolation[];
  readonly circularCycles: readonly string[];
  readonly packageDependencyCount: number;
  readonly devDependencyCount: number;
  readonly hasDeprecatedPackages: readonly string[];
  readonly excessivelyConnectedFiles: readonly { readonly file: string; readonly fanOut: number }[];
  readonly isolatedFiles: number;
  readonly packageVersionPinned: boolean;
  readonly dependencyHealthScore: number;
}

const LAYER_RULES: ReadonlyArray<{
  readonly from: RegExp;
  readonly to: RegExp;
  readonly rule: string;
}> = [
  {
    from: /\/(presentation|ui|views|screens|pages|widgets)\//i,
    to: /\/data\//i,
    rule: 'Presentation must not import Data directly — depend on Domain interfaces.',
  },
  {
    from: /\/(presentation|ui|views|screens|pages|widgets)\//i,
    to: /repository_impl|_repository_impl|_datasource|_data_source/i,
    rule: 'Presentation imports a Data implementation — inject via domain interface.',
  },
  {
    from: /\/domain\//i,
    to: /\/data\//i,
    rule: 'Domain must not import Data — invert dependency through repository interfaces.',
  },
  {
    from: /\/domain\//i,
    to: /^package:flutter\//i,
    rule: 'Domain must remain framework-agnostic — remove Flutter imports from domain layer.',
  },
];

const DEPRECATED_PACKAGES = [
  'pedantic',
  'effective_dart',
  'flutter_driver',
  'connectivity',
  'device_info',
  'package_info',
  'battery',
  'sensors',
];

const HIGH_FAN_OUT = 10;

@injectable()
export class DependencyAnalyzer implements ProjectAnalysisEngine<DependencyFacts> {
  readonly name = 'dependency';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<DependencyFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;

    const layerViolations = detectLayerViolations(snapshot);
    const circularCycles = detectCycles(snapshot.importEdges).slice(0, 25);

    const fanOutMap = new Map<string, number>();
    for (const edge of snapshot.importEdges) {
      fanOutMap.set(edge.from, (fanOutMap.get(edge.from) ?? 0) + 1);
    }
    const excessivelyConnectedFiles = [...fanOutMap.entries()]
      .filter(([, fanOut]) => fanOut >= HIGH_FAN_OUT)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file, fanOut]) => ({ file, fanOut }));

    const nodesWithEdges = new Set([
      ...snapshot.importEdges.map((e) => e.from),
      ...snapshot.importEdges.map((e) => e.to),
    ]);
    const libFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('lib/'));
    const isolatedFiles = libFiles.filter((f) => !nodesWithEdges.has(f.relativePath)).length;

    const hasDeprecatedPackages = DEPRECATED_PACKAGES.filter((p) =>
      snapshot.dependencies.includes(p),
    );

    const packageVersionPinned = detectVersionPinning(snapshot.pubspecRaw ?? '');

    const dependencyHealthScore = computeHealthScore({
      layerViolationCount: layerViolations.length,
      circularCycleCount: circularCycles.length,
      deprecatedCount: hasDeprecatedPackages.length,
      excessivelyConnectedCount: excessivelyConnectedFiles.length,
      totalEdges: snapshot.importEdges.length,
    });

    const facts: DependencyFacts = {
      totalEdges: snapshot.importEdges.length,
      totalNodes: nodesWithEdges.size,
      layerViolations,
      circularCycles,
      packageDependencyCount: snapshot.dependencies.length,
      devDependencyCount: snapshot.devDependencies.length,
      hasDeprecatedPackages,
      excessivelyConnectedFiles,
      isolatedFiles,
      packageVersionPinned,
      dependencyHealthScore,
    };

    if (layerViolations.length > 0) {
      const uniqueRules = [...new Set(layerViolations.map((v) => v.rule))];
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'dependency',
            code: 'LayerViolations',
            title: `${layerViolations.length} architectural layer violation(s) detected`,
            description: `Import rules are broken: ${uniqueRules[0]}`,
            evidence: layerViolations.slice(0, 8).map((v) => `${v.from} → ${v.to} (${v.rule})`),
            recommendedFix: 'Enforce layer boundaries by depending on interfaces defined in the inner layer. Use DI to inject implementations.',
            officialReference: this.refs.lookupDoc('clean architecture'),
            source: 'import_graph',
            confidence: 0.95,
            basis: 'ast',
            scoreImpact: -12,
            whyItMatters: 'Layer violations couple concrete implementations to callers, blocking independent testing and future refactoring.',
          },
          ast,
        ),
      );
    } else if (snapshot.importEdges.length > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'dependency',
            code: 'NoLayerViolations',
            title: 'No architectural layer violations detected in import graph',
            description: 'Import edges respect known layer boundaries (presentation/domain/data).',
            evidence: [`edgesChecked=${snapshot.importEdges.length}`],
            recommendedFix: null,
            source: 'import_graph',
            confidence: 0.88,
            basis: 'ast',
            scoreImpact: 8,
          },
          ast,
        ),
      );
    }

    if (circularCycles.length > 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'dependency',
            code: 'CircularDependencies',
            title: `${circularCycles.length} circular import cycle(s) detected`,
            description: 'Circular imports prevent independent compilation, hinder testing, and indicate coupling violations.',
            evidence: circularCycles.slice(0, 6),
            recommendedFix: 'Break cycles by extracting shared types into a neutral module, or by inverting dependencies through interfaces.',
            source: 'import_graph',
            confidence: 0.88,
            basis: 'ast',
            scoreImpact: -10,
            whyItMatters: 'Circular dependencies make build order fragile and prevent extracting features into packages.',
          },
          ast,
        ),
      );
    } else if (snapshot.importEdges.length > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'dependency',
            code: 'NoCircularDependencies',
            title: 'Dependency graph is acyclic',
            description: 'Best-effort cycle detection found no circular imports.',
            evidence: [`edges=${snapshot.importEdges.length}`],
            recommendedFix: null,
            source: 'import_graph',
            confidence: 0.85,
            basis: 'ast',
            scoreImpact: 6,
          },
          ast,
        ),
      );
    }

    if (excessivelyConnectedFiles.length > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'dependency',
            code: 'HighFanOutFiles',
            title: `${excessivelyConnectedFiles.length} files are excessively connected (fan-out ≥${HIGH_FAN_OUT})`,
            description: 'Files that import many others often carry too many responsibilities.',
            evidence: excessivelyConnectedFiles.slice(0, 5).map((f) => `${f.file} (${f.fanOut} imports)`),
            recommendedFix: 'Split along domain boundaries. High-fan-out files are good candidates for god-class review.',
            source: 'import_graph',
            confidence: 0.8,
            basis: 'ast',
            scoreImpact: -4,
          },
          ast,
        ),
      );
    }

    if (hasDeprecatedPackages.length > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'dependency',
            code: 'DeprecatedPackages',
            title: `${hasDeprecatedPackages.length} deprecated package(s) detected`,
            description: `Deprecated packages: ${hasDeprecatedPackages.join(', ')}.`,
            evidence: hasDeprecatedPackages,
            recommendedFix: 'Replace deprecated packages with their official successors listed on pub.dev.',
            source: 'pubspec',
            confidence: 0.95,
            basis: 'ast',
            scoreImpact: -5,
          },
          ast,
        ),
      );
    }

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

function detectLayerViolations(snapshot: ProjectSnapshot): LayerViolation[] {
  const violations: LayerViolation[] = [];
  for (const file of snapshot.dartFiles) {
    for (const imp of file.imports) {
      for (const rule of LAYER_RULES) {
        if (rule.from.test(file.relativePath) && rule.to.test(imp)) {
          violations.push({ from: file.relativePath, to: imp, rule: rule.rule });
        }
      }
    }
  }
  return violations;
}

function detectVersionPinning(pubspecRaw: string): boolean {
  return /^\s+\w[\w_-]+:\s+\d+\.\d+\.\d+\s*$/m.test(pubspecRaw);
}

function computeHealthScore(input: {
  layerViolationCount: number;
  circularCycleCount: number;
  deprecatedCount: number;
  excessivelyConnectedCount: number;
  totalEdges: number;
}): number {
  let score = 80;
  score -= Math.min(25, input.layerViolationCount * 5);
  score -= Math.min(20, input.circularCycleCount * 4);
  score -= Math.min(15, input.deprecatedCount * 5);
  score -= Math.min(10, input.excessivelyConnectedCount * 2);
  if (input.totalEdges === 0) score = 50;
  return Math.max(0, Math.min(100, score));
}

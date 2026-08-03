import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import type { ArchitectureFacts } from '../engines/architecture-analyzer.js';
import type { CodeQualityFacts } from '../engines/code-quality-analyzer.js';
import type { StateManagementFacts } from '../engines/state-management-analyzer.js';
import { KnowledgeEngine } from '../knowledge/knowledge-engine.js';
import { FindingRelationshipEngine } from '../relationships/finding-relationship-engine.js';
import type {
  AnalysisFinding,
  AnalysisSummary,
  EvidenceItem,
  OfficialReference,
  ProjectInsight,
  ProjectMetrics,
  ProjectSnapshot,
  TechnicalDebtReport,
} from '../types.js';
import type { FindingRecommendation } from './recommendation-engine.js';
import { RecommendationEngine } from './recommendation-engine.js';

export interface FindingExplanation {
  readonly summary: string;
  readonly whyThisMatters: string;
  readonly technicalExplanation: string;
  readonly evidence: readonly EvidenceItem[];
  readonly evidenceSummaries: readonly string[];
  readonly officialGuidance: string;
  readonly officialReferences: readonly OfficialReference[];
  readonly realFlutterExamples: readonly OfficialReference[];
  readonly suggestedArchitecture: string;
  readonly relatedFlutterWidgets: readonly string[];
  readonly relatedApis: readonly string[];
  readonly expectedImprovement: string;
  readonly potentialTradeoffs: readonly string[];
  readonly relatedFindings: readonly { readonly code: string; readonly title: string }[];
  readonly recommendation: FindingRecommendation;
  readonly confidence: number;
}

@injectable()
export class ExplanationEngine {
  constructor(
    @inject(TYPES.RecommendationEngine) private readonly recommendations: RecommendationEngine,
    @inject(TYPES.KnowledgeEngine) private readonly knowledge: KnowledgeEngine,
    @inject(TYPES.FindingRelationshipEngine)
    private readonly relationships: FindingRelationshipEngine,
  ) {}

  explain(input: {
    readonly snapshot: ProjectSnapshot;
    readonly summary: AnalysisSummary;
    readonly metrics: ProjectMetrics;
    readonly findings: readonly AnalysisFinding[];
    readonly architecture: ArchitectureFacts;
    readonly codeQuality: CodeQualityFacts;
    readonly stateManagement: StateManagementFacts;
    readonly technicalDebt?: TechnicalDebtReport;
  }): ProjectInsight {
    const { snapshot, summary, metrics, architecture, codeQuality, stateManagement, findings } =
      input;

    const packageLabel = snapshot.packageName ?? 'this project';
    const astNote =
      summary.astSource === 'dart_analyzer'
        ? `Symbols were extracted with the Dart Analyzer (${summary.coverage} coverage, aggregate confidence ${(summary.confidence * 100).toFixed(0)}%).`
        : `Symbols were extracted with the heuristic fallback (${summary.coverage} coverage, aggregate confidence ${(summary.confidence * 100).toFixed(0)}%). ${summary.recommendation ?? ''}`.trim();

    const architectureNarrative = buildArchitectureNarrative(architecture, metrics);
    const stateNarrative = buildStateNarrative(stateManagement);
    const qualityNarrative = buildQualityNarrative(codeQuality, findings);

    const ranked = [...findings].sort(
      (a, b) => severityRank(b.severity) * b.confidence - severityRank(a.severity) * a.confidence,
    );
    const topRisks = ranked
      .filter((f) => f.severity === 'negative' || f.severity === 'warning')
      .slice(0, 5)
      .map((f) => `${f.title} (confidence ${(f.confidence * 100).toFixed(0)}%, source=${f.source})`);
    const strengths = ranked
      .filter((f) => f.severity === 'positive')
      .slice(0, 5)
      .map((f) => f.title);

    const debtLine = input.technicalDebt
      ? ` Technical debt ${input.technicalDebt.debtScore}/100 — ${input.technicalDebt.summary}`
      : '';

    const overview = [
      `${packageLabel} looks like a ${snapshot.isFlutterProject ? 'Flutter' : 'Dart'} project with ${metrics.libFileCount} lib files, ${metrics.widgetCount} widgets, and ${metrics.linesOfCode} lines of Dart.`,
      `Closest matching architecture: ${architecture.detectedArchitecture} (detection confidence ${architecture.confidence}%). Dependency picture: ${architecture.dependencyDirectionSummary}.`,
      `State approaches in play: ${stateManagement.detectedApproaches.join(', ') || 'unknown'}.`,
      astNote,
      topRisks.length > 0
        ? `Highest-priority risks: ${topRisks.slice(0, 3).join('; ')}.`
        : 'No high-severity risks were flagged from the measured facts.',
      debtLine,
    ]
      .join(' ')
      .trim();

    return {
      overview,
      architecture: architectureNarrative,
      stateManagement: stateNarrative,
      codeQuality: qualityNarrative,
      topRisks,
      strengths,
    };
  }

  explainFinding(
    finding: AnalysisFinding,
    allFindings: readonly AnalysisFinding[],
  ): FindingExplanation {
    const enriched = this.knowledge.enrichFinding(finding);
    const recommendation = this.recommendations.explainFinding(enriched, allFindings);
    const related = this.relationships.relatedOf(enriched, allFindings).map((f) => ({
      code: f.code,
      title: f.title,
    }));

    const refs = enriched.officialReferences ?? [];
    const examples = refs.filter((r) => r.kind === 'sample' || r.kind === 'widget_test');
    const docs = refs.filter(
      (r) => r.kind === 'documentation' || r.kind === 'migration' || r.kind === 'framework_source',
    );

    return {
      summary: `${enriched.title}. ${enriched.description}`,
      whyThisMatters: recommendation.whyItMatters,
      technicalExplanation: buildTechnicalExplanation(enriched),
      evidence: enriched.evidenceItems ?? [],
      evidenceSummaries: enriched.evidence,
      officialGuidance: recommendation.officialGuidance,
      officialReferences: docs,
      realFlutterExamples: examples,
      suggestedArchitecture: recommendation.suggestedRefactor,
      relatedFlutterWidgets: relatedWidgetsFor(enriched),
      relatedApis: relatedApisFor(enriched),
      expectedImprovement: recommendation.expectedImpact,
      potentialTradeoffs: tradeoffsFor(enriched),
      relatedFindings: related,
      recommendation,
      confidence: enriched.confidence,
    };
  }
}

function buildTechnicalExplanation(f: AnalysisFinding): string {
  switch (f.code) {
    case 'PresentationImportsData':
      return 'In a layered/clean layout, presentation may depend on domain abstractions (e.g. repository interfaces) but must not import concrete data-layer types. An import edge from presentation/ui into data/ (or *RepositoryImpl) is a measured dependency-rule violation.';
    case 'DomainImportsFlutter':
      return 'Domain code that imports package:flutter pulls framework types into business rules. That prevents plain-Dart unit tests and couples domain evolution to UI SDK changes.';
    case 'GodClassCandidate':
      return 'Files/classes at or above the size threshold concentrate many responsibilities. Call sites and rebuild boundaries become unclear; changes risk unrelated regressions.';
    case 'LargeBuildMethod':
      return 'Oversized Widget.build methods compose too much UI in one place, which obscures structure and makes targeted rebuilds/testing harder.';
    default:
      return f.description;
  }
}

function relatedWidgetsFor(f: AnalysisFinding): string[] {
  switch (f.code) {
    case 'LegacyButtonApi':
      return ['ElevatedButton', 'TextButton', 'OutlinedButton'];
    case 'MissingDispose':
      return ['StatefulWidget', 'TextEditingController', 'AnimationController'];
    case 'HeavySetState':
      return ['StatefulWidget', 'InheritedWidget'];
    case 'ConstOpportunities':
      return ['StatelessWidget'];
    default:
      return [];
  }
}

function relatedApisFor(f: AnalysisFinding): string[] {
  switch (f.code) {
    case 'DebugPrint':
      return ['debugPrint'];
    case 'MissingDispose':
      return ['State.dispose', 'ChangeNotifier.dispose'];
    case 'HeavySetState':
      return ['State.setState'];
    default:
      return [];
  }
}

function tradeoffsFor(f: AnalysisFinding): string[] {
  switch (f.code) {
    case 'PresentationImportsData':
      return [
        'Introducing interfaces adds a small amount of boilerplate',
        'DI wiring must be kept consistent at the composition root',
      ];
    case 'GodClassCandidate':
    case 'LargeBuildMethod':
      return [
        'Extracting widgets can increase file count',
        'Passing props through constructors needs careful API design',
      ];
    default:
      return ['Short-term churn while boundaries are clarified'];
  }
}

function buildArchitectureNarrative(facts: ArchitectureFacts, metrics: ProjectMetrics): string {
  const layers = [
    facts.hasPresentation ? 'presentation' : null,
    facts.hasDomain ? 'domain' : null,
    facts.hasData ? 'data' : null,
    facts.hasCore ? 'core' : null,
    facts.hasShared ? 'shared' : null,
    facts.hasFeatures ? `features(${facts.featureDirCount})` : null,
  ].filter(Boolean);

  return [
    `Detected structure is "${facts.detectedArchitecture}" with ${facts.confidence}% confidence from folder layout and import edges — not an LLM guess.`,
    layers.length > 0
      ? `Observed layers/modules: ${layers.join(', ')}.`
      : 'No clear domain/data/presentation/feature folders were observed under lib/.',
    `Dependency direction: ${facts.dependencyDirectionSummary}.`,
    facts.circularDependencies.length > 0
      ? `${facts.circularDependencies.length} circular import cycle(s) were detected; these block clean feature ownership.`
      : 'No circular imports were detected in the analyzed edge set.',
    `Maintainability ${facts.maintainabilityScore}/100 and scalability ${facts.scalabilityScore}/100 come from those same structural facts (tests=${metrics.testFileCount}, lib=${metrics.libFileCount}).`,
  ].join(' ');
}

function buildStateNarrative(facts: StateManagementFacts): string {
  const primary = facts.detectedApproaches.filter((a) => a !== 'unknown');
  return [
    primary.length > 0
      ? `State appears to use: ${primary.join(', ')}${facts.dependencySignals.length > 0 ? ` (pubspec: ${facts.dependencySignals.join(', ')})` : ''}.`
      : 'No clear state-management library or pattern was detected yet.',
    `Local UI state signals: ${facts.statefulWidgetCount} StatefulWidget(s), ${facts.setStateCallSites} setState call site(s).`,
    facts.businessLogicInWidgetsHints > 0
      ? `${facts.businessLogicInWidgetsHints} widget/State file(s) show possible network/repository calls — presentation may own data-layer work.`
      : 'No strong data/network leakage into widgets was detected by the heuristic scan.',
    facts.controllerFieldHints > 0 && facts.disposeMethodCount === 0
      ? 'Controller-like fields were found without matching dispose() methods — lifecycle risk.'
      : facts.disposeMethodCount > 0
        ? `Lifecycle cleanup: ${facts.disposeMethodCount} dispose() method(s) present near ${facts.controllerFieldHints} controller hint(s).`
        : 'No controller/dispose lifecycle issues were flagged.',
    `State maintainability ${facts.maintainabilityScore}/100, scalability ${facts.scalabilityScore}/100 from measured approach mix and usage intensity.`,
  ].join(' ');
}

function buildQualityNarrative(
  facts: CodeQualityFacts,
  findings: readonly AnalysisFinding[],
): string {
  const negatives = findings.filter(
    (f) =>
      (f.severity === 'negative' || f.severity === 'warning') &&
      ['oop', 'solid', 'dart', 'flutter', 'data_structures'].includes(f.category),
  );
  return [
    `Codebase snapshot: ${facts.classCount} classes, ${facts.widgetCount} widgets, ${facts.mixinCount} mixins, ${facts.extensionCount} extensions across ${facts.dartFileCount} Dart files.`,
    facts.godClassDetails?.length > 0
      ? `${facts.godClassDetails.length} multi-signal god-class candidate(s); ${facts.largeClassCandidates?.length ?? 0} large files (≥400 LOC) as size-only triage.`
      : facts.largeClassCandidates?.length
        ? `${facts.largeClassCandidates.length} large class candidate(s) (≥400 LOC) — size alone, not automatic god classes.`
        : 'No extreme god-class scores or oversized class files were flagged.',
    facts.largeBuildMethods.length > 0
      ? `${facts.largeBuildMethods.length} large build method(s) suggest extracting widgets.`
      : 'Build methods look reasonably sized under the ~80-line heuristic.',
    facts.legacyButtonUsages > 0
      ? `Legacy Material buttons still appear (${facts.legacyButtonUsages} hit(s)) — migrate to Elevated/Text/OutlinedButton.`
      : 'No obsolete RaisedButton/FlatButton/OutlineButton usages were found.',
    negatives.length > 0
      ? `Top quality concerns: ${negatives
          .slice(0, 3)
          .map((f) => f.title)
          .join('; ')}.`
      : 'No major quality negatives were raised from the measured rules.',
  ].join(' ');
}

function severityRank(severity: AnalysisFinding['severity']): number {
  switch (severity) {
    case 'negative':
      return 4;
    case 'warning':
      return 3;
    case 'info':
      return 1;
    case 'positive':
      return 0;
    default:
      return 0;
  }
}

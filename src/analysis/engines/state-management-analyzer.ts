import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import { OfficialReferenceResolver } from '../official-refs.js';
import type {
  AnalysisFinding,
  AnalyzerResult,
  ProjectAnalysisEngine,
  ProjectSnapshot,
} from '../types.js';
import { astOrFallback, finding } from './finding-factory.js';

export type DetectedStateApproach =
  | 'bloc'
  | 'cubit'
  | 'riverpod'
  | 'provider'
  | 'getx'
  | 'mobx'
  | 'redux'
  | 'inherited_widget'
  | 'set_state'
  | 'change_notifier'
  | 'signals'
  | 'custom'
  | 'unknown';

export interface StateManagementFacts {
  readonly detectedApproaches: readonly DetectedStateApproach[];
  readonly dependencySignals: readonly string[];
  readonly setStateCallSites: number;
  readonly localSetStateSites: number;
  readonly problematicSetStateSites: number;
  readonly statefulWidgetCount: number;
  readonly changeNotifierCount: number;
  readonly providerScopeHints: number;
  readonly riverpodHints: number;
  readonly blocHints: number;
  readonly getxHints: number;
  readonly globalMutableCandidates: number;
  readonly disposeMethodCount: number;
  readonly controllerFieldHints: number;
  readonly businessLogicInWidgetsHints: number;
  readonly featuresWithMixedLibraries: readonly string[];
  readonly maintainabilityScore: number;
  readonly scalabilityScore: number;
}

@injectable()
export class StateManagementAnalyzer implements ProjectAnalysisEngine<StateManagementFacts> {
  readonly name = 'state_management';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<StateManagementFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;
    const dependencySignals: string[] = [];
    const approaches = new Set<DetectedStateApproach>();

    const depMap: Array<[string, DetectedStateApproach]> = [
      ['flutter_bloc', 'bloc'],
      ['bloc', 'bloc'],
      ['flutter_riverpod', 'riverpod'],
      ['riverpod', 'riverpod'],
      ['hooks_riverpod', 'riverpod'],
      ['provider', 'provider'],
      ['get', 'getx'],
      ['getx', 'getx'],
      ['flutter_mobx', 'mobx'],
      ['mobx', 'mobx'],
      ['redux', 'redux'],
      ['flutter_redux', 'redux'],
      ['signals', 'signals'],
    ];

    for (const [dep, approach] of depMap) {
      if (snapshot.dependencies.includes(dep) || snapshot.devDependencies.includes(dep)) {
        approaches.add(approach);
        dependencySignals.push(dep);
      }
    }

    let setStateCallSites = 0;
    let localSetStateSites = 0;
    let problematicSetStateSites = 0;
    let statefulWidgetCount = 0;
    let changeNotifierCount = 0;
    let providerScopeHints = 0;
    let riverpodHints = 0;
    let blocHints = 0;
    let getxHints = 0;
    let globalMutableCandidates = 0;
    let disposeMethodCount = 0;
    let controllerFieldHints = 0;
    let businessLogicInWidgetsHints = 0;
    const featureLibraries = new Map<string, Set<string>>();

    for (const symbol of snapshot.symbols) {
      if (symbol.extendsClause?.includes('StatefulWidget')) {
        statefulWidgetCount += 1;
        approaches.add('set_state');
      }
      if (symbol.extendsClause?.includes('ChangeNotifier')) {
        changeNotifierCount += 1;
        approaches.add('change_notifier');
      }
      if (symbol.extendsClause?.includes('InheritedWidget')) {
        approaches.add('inherited_widget');
      }
      if (/Bloc$|Cubit$/.test(symbol.name) || symbol.extendsClause?.includes('Bloc')) {
        blocHints += 1;
        approaches.add(symbol.name.endsWith('Cubit') ? 'cubit' : 'bloc');
      }
    }

    for (const file of snapshot.dartFiles) {
      const content = file.content;
      const feature = featureNameFromPath(file.relativePath);
      const setStates = content.match(/\bsetState\s*\(/g);
      const setCount = setStates?.length ?? 0;
      setStateCallSites += setCount;
      if (setCount > 0) {
        approaches.add('set_state');
        const problematic = isProblematicSetStateContext(content);
        if (problematic) {
          problematicSetStateSites += setCount;
        } else {
          localSetStateSites += setCount;
        }
      }

      const fileRiverpod = countMatches(
        content,
        /\b(ProviderScope|ref\.watch|ConsumerWidget|HookConsumerWidget|StateNotifierProvider)/g,
      );
      const fileBloc = countMatches(content, /\b(BlocProvider|BlocBuilder|BlocListener|Cubit\s*<)/g);
      const fileProvider = countMatches(
        content,
        /\b(ChangeNotifierProvider|MultiProvider|Provider\s*<)/g,
      );
      const fileGetx = countMatches(content, /\b(GetxController|Obx\s*\(|Get\.put|Get\.find)/g);

      providerScopeHints += fileProvider;
      riverpodHints += fileRiverpod;
      blocHints += fileBloc;
      getxHints += fileGetx;

      if (feature) {
        const libs = featureLibraries.get(feature) ?? new Set<string>();
        if (fileRiverpod > 0) libs.add('riverpod');
        if (fileBloc > 0) libs.add('bloc');
        if (fileProvider > 0) libs.add('provider');
        if (fileGetx > 0) libs.add('getx');
        featureLibraries.set(feature, libs);
      }

      disposeMethodCount += countMatches(content, /\bvoid\s+dispose\s*\(/g);
      controllerFieldHints += countMatches(
        content,
        /\b(TextEditingController|ScrollController|AnimationController|FocusNode)\b/g,
      );

      if (
        /^[a-z].*=\s*(true|false|\d+|\[|\{)/m.test(content) &&
        /^(var|List|Map)\s+\w+\s*=/m.test(content)
      ) {
        if (
          /^(List|Map|var|Set)\s+[a-zA-Z_]/.test(
            content.split(/\r?\n/).find((l) => /^(List|Map|var|Set)\s+/.test(l)) ?? '',
          )
        ) {
          globalMutableCandidates += 1;
        }
      }

      if (
        (file.relativePath.includes('widget') || /extends\s+State</.test(content)) &&
        /\b(http\.|Dio\(|FirebaseFirestore|\.collection\(|Repository\()/i.test(content)
      ) {
        businessLogicInWidgetsHints += 1;
      }
    }

    if (riverpodHints > 0) approaches.add('riverpod');
    if (providerScopeHints > 0) approaches.add('provider');
    if (blocHints > 0) approaches.add('bloc');
    if (getxHints > 0) approaches.add('getx');

    if (approaches.size === 0) {
      approaches.add('unknown');
    }

    const detectedApproaches = [...approaches];
    const featuresWithMixedLibraries = [...featureLibraries.entries()]
      .filter(([, libs]) => libs.size >= 2)
      .map(([name, libs]) => `${name}:{${[...libs].join(',')}}`);

    const libraryApproaches = detectedApproaches.filter(
      (a) => !['set_state', 'change_notifier', 'inherited_widget', 'unknown', 'custom'].includes(a),
    );

    const maintainabilityScore = clampScore(
      80 -
        (featuresWithMixedLibraries.length > 0
          ? Math.min(15, featuresWithMixedLibraries.length * 5)
          : libraryApproaches.length > 2
            ? 5
            : 0) -
        (problematicSetStateSites > 15 ? 12 : problematicSetStateSites > 5 ? 6 : 0) -
        (businessLogicInWidgetsHints > 0 ? 15 : 0) -
        (controllerFieldHints > 0 && disposeMethodCount === 0 ? 10 : 0),
    );
    const scalabilityScore = clampScore(
      75 -
        (problematicSetStateSites > 30 ? 20 : problematicSetStateSites > 15 ? 8 : 0) -
        (detectedApproaches.includes('getx') ? 5 : 0) +
        (detectedApproaches.includes('riverpod') || detectedApproaches.includes('bloc') ? 10 : 0) -
        (businessLogicInWidgetsHints > 2 ? 15 : 0) -
        (featuresWithMixedLibraries.length > 2 ? 8 : 0),
    );

    const facts: StateManagementFacts = {
      detectedApproaches,
      dependencySignals,
      setStateCallSites,
      localSetStateSites,
      problematicSetStateSites,
      statefulWidgetCount,
      changeNotifierCount,
      providerScopeHints,
      riverpodHints,
      blocHints,
      getxHints,
      globalMutableCandidates,
      disposeMethodCount,
      controllerFieldHints,
      businessLogicInWidgetsHints,
      featuresWithMixedLibraries,
      maintainabilityScore,
      scalabilityScore,
    };

    findings.push(
      finding(
        {
          severity: 'info',
          category: 'state_management',
          code: 'DetectedApproaches',
          title: 'Detected state management approaches',
          description: 'Based on pubspec dependencies and source patterns (deterministic).',
          evidence: [
            `approaches=${detectedApproaches.join(', ')}`,
            `deps=${dependencySignals.join(', ') || 'none'}`,
            `setState total=${setStateCallSites} (local≈${localSetStateSites}, problematic≈${problematicSetStateSites})`,
            `StatefulWidget count=${statefulWidgetCount}`,
            `featuresWithMixedLibraries=${featuresWithMixedLibraries.length}`,
          ],
          recommendedFix: null,
          officialReference: this.refs.lookupDoc('state management'),
          source: dependencySignals.length > 0 ? 'pubspec' : 'heuristic',
          confidence: dependencySignals.length > 0 ? 0.98 : 0.75,
          dependsOnAst: dependencySignals.length === 0,
          basis: dependencySignals.length > 0 ? 'ast' : astOrFallback(ast),
          whyItMatters:
            'The primary state approach dictates where business logic lives and how features scale.',
        },
        ast,
      ),
    );

    if (featuresWithMixedLibraries.length > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'state_management',
            code: 'MultipleStateLibraries',
            title: 'Multiple state libraries inside the same feature',
            description:
              'Mixing Riverpod/Bloc/Provider/GetX within one feature increases cognitive load. Cross-feature coexistence during migration is less severe.',
            evidence: featuresWithMixedLibraries.slice(0, 10),
            recommendedFix:
              'Standardize on one primary approach per feature; allow temporary coexistence only across feature boundaries during migration.',
            source: 'filesystem',
            confidence: 0.88,
            basis: 'pattern',
            scoreImpact: -Math.min(12, 4 + featuresWithMixedLibraries.length * 2),
            whyItMatters:
              'Same-feature mixed libraries force developers to reason about multiple patterns in one module.',
          },
          ast,
        ),
      );
    } else if (libraryApproaches.length > 2) {
      findings.push(
        finding(
          {
            severity: 'info',
            category: 'state_management',
            code: 'MultipleStateLibrariesAcrossApp',
            title: 'Multiple state libraries across the app (no same-feature collision detected)',
            description:
              'Several libraries appear project-wide but not co-located in the same feature folder — often fine during migration.',
            evidence: libraryApproaches.map((a) => `approach:${a}`),
            recommendedFix: 'Prefer converging on one primary approach over time.',
            source: 'pubspec',
            confidence: 0.8,
            basis: 'pattern',
            scoreImpact: -3,
          },
          ast,
        ),
      );
    }

    if (problematicSetStateSites > 10) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'state_management',
            code: 'HeavySetState',
            title: 'Problematic setState usage (shared/business/network context)',
            description:
              'setState co-located with network/repo/shared-state patterns — local UI setState is excluded from this penalty.',
            evidence: [
              `problematicSetStateSites≈${problematicSetStateSites}`,
              `localSetStateSites≈${localSetStateSites}`,
              `total setState=${setStateCallSites}`,
            ],
            recommendedFix:
              'Lift shared / network / long-lived state into Riverpod/Bloc/ChangeNotifier; keep setState for ephemeral UI only.',
            officialReference: this.refs.lookupSymbol('StatefulWidget'),
            source: 'heuristic',
            confidence: 0.78,
            basis: 'pattern',
            scoreImpact: -Math.min(12, 4 + Math.floor(problematicSetStateSites / 10)),
            whyItMatters:
              'Business and cross-widget state in setState hurts testability and rebuild control; local toggles are fine.',
          },
          ast,
        ),
      );
    } else if (localSetStateSites > 0 && localSetStateSites <= 40 && problematicSetStateSites === 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'state_management',
            code: 'ModestSetState',
            title: 'setState appears local/ephemeral',
            description:
              'setState sites look like local UI state (no network/repo co-location detected).',
            evidence: [
              `${localSetStateSites} local setState sites across ${statefulWidgetCount} StatefulWidgets`,
            ],
            recommendedFix: null,
            source: 'heuristic',
            confidence: 0.8,
            basis: 'pattern',
            scoreImpact: 4,
          },
          ast,
        ),
      );
    }

    if (controllerFieldHints > 0 && disposeMethodCount === 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'state_management',
            code: 'MissingDispose',
            title: 'Controllers/FocusNodes without dispose() detected',
            description: 'Controllers must be disposed to avoid leaks.',
            evidence: [
              `controller-like fields≈${controllerFieldHints}`,
              `dispose methods=${disposeMethodCount}`,
            ],
            recommendedFix: 'Override dispose() and dispose controllers/animation/focus nodes.',
            officialReference: this.refs.lookupSymbol('TextEditingController'),
            source: 'heuristic',
            confidence: 0.7,
            basis: 'pattern',
            scoreImpact: -10,
            whyItMatters: 'Undisposed controllers leak listeners and hold onto Element trees.',
          },
          ast,
        ),
      );
    } else if (controllerFieldHints > 0 && disposeMethodCount > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'state_management',
            code: 'HasDisposeMethods',
            title: 'dispose() methods present near controllers',
            description:
              'Lifecycle cleanup methods were found (verify each controller is disposed).',
            evidence: [
              `dispose methods=${disposeMethodCount}`,
              `controller hints=${controllerFieldHints}`,
            ],
            recommendedFix: null,
            source: 'heuristic',
            confidence: 0.75,
            basis: 'pattern',
            scoreImpact: 5,
          },
          ast,
        ),
      );
    }

    if (businessLogicInWidgetsHints > 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'state_management',
            code: 'LogicInWidgets',
            title: 'Possible data/network logic inside widgets',
            description:
              'HTTP/Firestore/repository calls inside widget/State files leak data-layer concerns into presentation.',
            evidence: [
              `${businessLogicInWidgetsHints} file(s) with network/repo patterns in widget/State context`,
            ],
            recommendedFix:
              'Move IO to repositories/use-cases; keep widgets focused on rendering + events.',
            officialReference: this.refs.lookupDoc('architecture'),
            source: 'heuristic',
            confidence: 0.72,
            basis: 'pattern',
            scoreImpact: -12,
            whyItMatters:
              'Presentation that owns IO is hard to test and hard to reuse across platforms or entry points.',
          },
          ast,
        ),
      );
    }

    if (changeNotifierCount > 0 && providerScopeHints === 0 && riverpodHints === 0) {
      findings.push(
        finding(
          {
            severity: 'info',
            category: 'state_management',
            code: 'ChangeNotifierWithoutProvider',
            title: 'ChangeNotifier without Provider/Riverpod wiring detected',
            description: 'Ensure notifiers are scoped and not used as uncontrolled globals.',
            evidence: [`ChangeNotifier subclasses≈${changeNotifierCount}`],
            recommendedFix: 'Expose notifiers via Provider/Riverpod or explicit DI scopes.',
            officialReference: this.refs.lookupSymbol('ChangeNotifier'),
            dependsOnAst: true,
            confidence: 0.8,
            basis: astOrFallback(ast),
            scoreImpact: -3,
          },
          ast,
        ),
      );
    }

    findings.push(
      finding(
        {
          severity: 'info',
          category: 'state_management',
          code: 'Scores',
          title: 'Deterministic maintainability/scalability scores',
          description: 'Heuristic scores derived only from measured facts (not opinions).',
          evidence: [
            `maintainabilityScore=${maintainabilityScore}`,
            `scalabilityScore=${scalabilityScore}`,
          ],
          recommendedFix: null,
          source: 'filesystem',
          confidence: 0.85,
          basis: 'pattern',
        },
        ast,
      ),
    );

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

function countMatches(content: string, re: RegExp): number {
  return content.match(re)?.length ?? 0;
}

function featureNameFromPath(relativePath: string): string | null {
  const m = /lib\/features\/([^/]+)\//i.exec(relativePath.replaceAll('\\', '/'));
  return m?.[1] ?? null;
}

function isProblematicSetStateContext(content: string): boolean {
  return (
    /\b(http\.|Dio\(|FirebaseFirestore|\.collection\(|Repository\(|ref\.watch|BlocProvider|Cubit)\b/i.test(
      content,
    ) ||
    /\b(SharedPreferences|Hive|Isar|sqflite)\b/i.test(content) ||
    (content.match(/\bsetState\s*\(/g)?.length ?? 0) >= 8
  );
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

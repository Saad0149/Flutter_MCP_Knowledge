import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import { OfficialReferenceResolver } from '../official-refs.js';
import type {
  AnalysisFinding,
  AnalyzerResult,
  DartFileInfo,
  ProjectAnalysisEngine,
  ProjectSnapshot,
} from '../types.js';
import { astOrFallback, finding } from './finding-factory.js';

export interface PerformanceFacts {
  readonly largeBuildMethodCount: number;
  readonly largeBuildMethods: readonly {
    readonly file: string;
    readonly line: number;
    readonly approxLines: number;
  }[];
  readonly constOpportunityCount: number;
  readonly setStateInBuildCount: number;
  readonly heavySetStateCount: number;
  readonly synchronousHeavyOpsInBuild: number;
  readonly animationControllerWithoutDisposeCount: number;
  readonly listViewBuilderMisuse: number;
  readonly imageWithoutCacheHints: number;
  readonly performanceScore: number;
}

const LARGE_BUILD_THRESHOLD = 60;

@injectable()
export class PerformanceAnalyzer implements ProjectAnalysisEngine<PerformanceFacts> {
  readonly name = 'performance';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<PerformanceFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;
    const libFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('lib/'));

    const largeBuildMethods: { file: string; line: number; approxLines: number }[] = [];
    let constOpportunityCount = 0;
    let setStateInBuildCount = 0;
    let heavySetStateCount = 0;
    let synchronousHeavyOpsInBuild = 0;
    let animationControllerWithoutDisposeCount = 0;
    let listViewBuilderMisuse = 0;
    let imageWithoutCacheHints = 0;

    for (const file of libFiles) {
      const content = file.content;
      const lines = content.split('\n');

      const build = extractLargestBuildMethod(file, lines);
      if (build && build.approxLines > LARGE_BUILD_THRESHOLD) {
        largeBuildMethods.push({ file: file.relativePath, line: build.line, approxLines: build.approxLines });
      }

      const newWidgetMatches = (content.match(/(?<![A-Za-z])new\s+[A-Z]/g) ?? []).length;
      constOpportunityCount += newWidgetMatches;

      if (/setState\s*\(/.test(content) && /build\s*\(/.test(content)) {
        const setStateInBuild = /build[^}]*setState\s*\(/s.test(content);
        if (setStateInBuild) setStateInBuildCount++;
      }

      const heavyStatePatterns = /setState\s*\([^)]*(?:await|http\.|Firestore|supabase|sqflite|compute\()/;
      if (heavyStatePatterns.test(content)) heavySetStateCount++;

      const syncHeavy = /Future\.wait|compute\(|Isolate\.run/.test(content)
        ? 0
        : /for\s*\([^)]{50,}\)/.test(content)
          ? 1
          : 0;
      synchronousHeavyOpsInBuild += syncHeavy;

      if (/AnimationController\(/.test(content) && !/dispose\(\)/.test(content)) {
        animationControllerWithoutDisposeCount++;
      }

      if (!file.relativePath.includes('test/')) {
        if (file.astMetrics) {
          listViewBuilderMisuse += file.astMetrics.listViewEagerCalls.length;
        } else if (/ListView\(children:\s*\[/.test(content)) {
          const childCount = (content.match(/ListView\(children:\s*\[/g) ?? []).length;
          if (childCount > 0) listViewBuilderMisuse += childCount;
        }
      }

      const imgCount = (content.match(/Image\.network\s*\(/g) ?? []).length;
      const cacheHints = (content.match(/cacheWidth|cacheHeight|CachedNetworkImage/g) ?? []).length;
      if (imgCount > cacheHints) imageWithoutCacheHints += imgCount - cacheHints;
    }

    const performanceScore = computePerformanceScore({
      largeBuildMethodCount: largeBuildMethods.length,
      constOpportunityCount,
      heavySetStateCount,
      animationWithoutDisposeCount: animationControllerWithoutDisposeCount,
      listViewMisuse: listViewBuilderMisuse,
      libFileCount: libFiles.length,
    });

    const facts: PerformanceFacts = {
      largeBuildMethodCount: largeBuildMethods.length,
      largeBuildMethods: largeBuildMethods.slice(0, 20),
      constOpportunityCount,
      setStateInBuildCount,
      heavySetStateCount,
      synchronousHeavyOpsInBuild,
      animationControllerWithoutDisposeCount,
      listViewBuilderMisuse,
      imageWithoutCacheHints,
      performanceScore,
    };

    if (largeBuildMethods.length > 0) {
      findings.push(
        finding(
          {
            severity: largeBuildMethods.length > 10 ? 'negative' : 'warning',
            category: 'flutter',
            code: 'LargeBuildMethod',
            title: `${largeBuildMethods.length} build() method(s) exceed ${LARGE_BUILD_THRESHOLD} lines`,
            description: 'Large build methods cause unnecessary rebuilds and are hard to profile.',
            // file:line (~N lines) — matches EvidenceEngine.parseEvidenceString's
            // build-method pattern so evidence gets structured (file/line/symbol),
            // not just an opaque string.
            evidence: largeBuildMethods
              .slice(0, 10)
              .map((m) => `${m.file}:${m.line} (~${m.approxLines} lines)`),
            recommendedFix: 'Extract sub-trees into named widget classes or const widgets. Keep build() focused on composition.',
            officialReference: this.refs.lookupDoc('build method'),
            source: 'heuristic',
            dependsOnAst: true,
            // Real build() body span from the parsed AST's own FunctionBody
            // offsets when astMetrics is available — a deterministic
            // structural fact (no brace-matching over text), so this is
            // near-exact rather than an estimate.
            confidence: 0.93,
            basis: astOrFallback(ast),
            scoreImpact: largeBuildMethods.length > 10 ? -15 : -8,
            whyItMatters: 'Large build methods trigger full subtree rebuilds and make performance profiling harder.',
          },
          ast,
        ),
      );
    } else if (libFiles.length > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'flutter',
            code: 'CompactBuildMethods',
            title: 'Build methods appear compact (all under 60 lines)',
            description: 'No widgets with excessively large build() methods detected.',
            evidence: [`libFiles=${libFiles.length}`],
            recommendedFix: null,
            source: 'heuristic',
            dependsOnAst: true,
            confidence: 0.88,
            basis: astOrFallback(ast),
            scoreImpact: 6,
          },
          ast,
        ),
      );
    }

    if (constOpportunityCount > 20) {
      // Distinct code from CodeQualityAnalyzer's 'ConstOpportunities': this
      // measures literal `new Foo(...)` keyword usage specifically, not
      // missing-const-on-modern-constructor-calls — a related but different
      // signal that used to collide on the same code (see
      // DUPLICATE_FINDINGS_AUDIT.md #4).
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'LegacyNewKeywordUsage',
            title: `~${constOpportunityCount} potential 'const' widget opportunities (using 'new')`,
            description: "Using 'new' for widgets that could be const prevents Flutter's rebuild optimization.",
            evidence: [`newWidgetCount=${constOpportunityCount}`],
            recommendedFix: "Replace `new Widget(...)` with `const Widget(...)` where all arguments are constants. Enable prefer_const_constructors lint.",
            source: 'heuristic',
            confidence: 0.7,
            basis: 'pattern',
            scoreImpact: -5,
            whyItMatters: "Non-const widgets rebuild on every parent build cycle; const widgets are cached and skipped.",
          },
          ast,
        ),
      );
    }

    if (heavySetStateCount > 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'state_management',
            code: 'HeavySetStateUsage',
            title: `${heavySetStateCount} setState call(s) wrap async/network operations`,
            description: 'Calling setState with heavy async work (network, DB) inside widgets mixes UI and business logic.',
            evidence: [`heavySetStateSites=${heavySetStateCount}`],
            recommendedFix: 'Move async operations into a controller, BLoC, or provider. Update state from outside the widget.',
            source: 'heuristic',
            confidence: 0.7,
            basis: 'pattern',
            scoreImpact: -8,
            whyItMatters: 'Async operations in setState can cause setState-after-dispose crashes and make unit testing impossible.',
          },
          ast,
        ),
      );
    }

    if (animationControllerWithoutDisposeCount > 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'flutter',
            code: 'AnimationControllerLeak',
            title: `${animationControllerWithoutDisposeCount} AnimationController(s) may not be disposed`,
            description: 'AnimationControllers must be disposed in dispose() to prevent memory leaks.',
            evidence: [`animationControllerWithoutDispose=${animationControllerWithoutDisposeCount}`],
            recommendedFix: 'Override dispose() and call controller.dispose(). Use SingleTickerProviderStateMixin.',
            officialReference: this.refs.lookupDoc('AnimationController'),
            source: 'heuristic',
            confidence: 0.7,
            basis: 'pattern',
            scoreImpact: -10,
            whyItMatters: 'Undisposed AnimationControllers leak memory and continue ticking after the widget is removed.',
          },
          ast,
        ),
      );
    }

    if (listViewBuilderMisuse > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'ListViewBuilderMisuse',
            title: `${listViewBuilderMisuse} ListView(children: [...]) usage(s) — prefer ListView.builder for dynamic content`,
            description: 'ListView with a children array renders all items eagerly, regardless of viewport.',
            evidence: [`occurrences=${listViewBuilderMisuse}`],
            recommendedFix: 'Use ListView.builder for lists longer than ~10 items. It only renders visible items.',
            officialReference: this.refs.lookupDoc('ListView'),
            source: 'heuristic',
            dependsOnAst: true,
            // Real named-argument detection on ListView constructor calls
            // (both bare `ListView(...)` and explicit `new`/`const`) when
            // astMetrics is available, correctly excluding `.builder`/
            // `.separated`. Not higher: no type resolution, so a
            // project-defined class also named `ListView`, or one reached
            // through an aliased/prefixed import, isn't distinguished.
            confidence: 0.88,
            basis: astOrFallback(ast),
            scoreImpact: -4,
          },
          ast,
        ),
      );
    }

    if (imageWithoutCacheHints > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'ImageWithoutCacheHints',
            title: `${imageWithoutCacheHints} Image.network() call(s) without cache sizing`,
            description: 'Loading full-resolution images without cacheWidth/cacheHeight wastes memory.',
            evidence: [`uncachedImages=${imageWithoutCacheHints}`],
            recommendedFix: 'Set cacheWidth/cacheHeight or use cached_network_image package.',
            source: 'heuristic',
            confidence: 0.7,
            basis: 'pattern',
            scoreImpact: -3,
          },
          ast,
        ),
      );
    }

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

/**
 * Picks the largest build() method in the file (a file can hold more than
 * one class/build method). Uses real AST body spans from astMetrics when
 * available; falls back to brace-matching over text otherwise.
 */
function extractLargestBuildMethod(
  file: DartFileInfo,
  lines: readonly string[],
): { readonly line: number; readonly approxLines: number } | null {
  if (file.astMetrics) {
    if (file.astMetrics.buildMethods.length === 0) {
      return null;
    }
    return file.astMetrics.buildMethods.reduce((max, b) =>
      b.approxLines > max.approxLines ? b : max,
    );
  }
  return extractBuildMethodLines(lines);
}

function extractBuildMethodLines(
  lines: readonly string[],
): { readonly line: number; readonly approxLines: number } | null {
  let inBuild = false;
  let depth = 0;
  let buildStart = -1;
  let maxBuildLines = 0;
  let maxBuildStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inBuild && /\bWidget\s+build\s*\(/.test(line)) {
      inBuild = true;
      depth = 0;
      buildStart = i;
    }
    if (inBuild) {
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      if (depth <= 0 && i > buildStart) {
        const lineCount = i - buildStart;
        if (lineCount > maxBuildLines) {
          maxBuildLines = lineCount;
          maxBuildStart = buildStart;
        }
        inBuild = false;
      }
    }
  }
  return maxBuildStart >= 0 ? { line: maxBuildStart + 1, approxLines: maxBuildLines } : null;
}

function computePerformanceScore(input: {
  largeBuildMethodCount: number;
  constOpportunityCount: number;
  heavySetStateCount: number;
  animationWithoutDisposeCount: number;
  listViewMisuse: number;
  libFileCount: number;
}): number {
  let score = 80;
  score -= Math.min(20, input.largeBuildMethodCount * 4);
  score -= Math.min(10, Math.floor(input.constOpportunityCount / 20) * 5);
  score -= Math.min(15, input.heavySetStateCount * 5);
  score -= Math.min(15, input.animationWithoutDisposeCount * 5);
  score -= Math.min(8, input.listViewMisuse * 2);
  if (input.libFileCount === 0) return 50;
  return Math.max(0, Math.min(100, score));
}

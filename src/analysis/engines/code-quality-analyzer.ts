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

export interface CodeQualityFacts {
  readonly dartFileCount: number;
  readonly widgetCount: number;
  readonly classCount: number;
  readonly mixinCount: number;
  readonly extensionCount: number;
  /** LOC ≥400 — size signal only, not automatically a god class. */
  readonly largeClassCandidates: readonly string[];
  /** Multi-signal god-class score ≥ threshold (back-compat name kept). */
  readonly godClassCandidates: readonly string[];
  readonly godClassDetails: readonly {
    readonly name: string;
    readonly file: string;
    readonly loc: number;
    readonly methodCount: number;
    readonly fieldCount: number;
    readonly importCount: number;
    readonly score: number;
    readonly confidence: number;
    readonly signals: readonly string[];
  }[];
  readonly deepInheritance: readonly string[];
  readonly largeBuildMethods: readonly { file: string; line: number; approxLines: number }[];
  readonly printCallSites: number;
  readonly legacyButtonUsages: number;
  readonly missingConstCandidates: number;
  readonly undocumentedWidgets: number;
  readonly usesSealedOrFinalClassKeywords: boolean;
  readonly usesPatternMatching: boolean;
  readonly listMapSetUsage: {
    readonly list: number;
    readonly map: number;
    readonly set: number;
  };
}

@injectable()
export class CodeQualityAnalyzer implements ProjectAnalysisEngine<CodeQualityFacts> {
  readonly name = 'code_quality';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<CodeQualityFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;
    const classes = snapshot.symbols.filter((s) => s.kind === 'class');
    const widgets = snapshot.symbols.filter((s) => s.isWidget);
    const mixins = snapshot.symbols.filter((s) => s.kind === 'mixin');
    const extensions = snapshot.symbols.filter((s) => s.kind === 'extension');

    const largeClassCandidates: string[] = [];
    const godClassDetails: CodeQualityFacts['godClassDetails'][number][] = [];

    for (const c of classes) {
      const file = snapshot.dartFiles.find((f) => f.relativePath === c.filePath);
      const loc = file?.lineCount ?? 0;
      if (loc < 400) continue;
      largeClassCandidates.push(`${c.name} (${c.filePath}, ${loc} LOC)`);
      const scored = scoreGodClass(c.name, file!);
      if (scored.score >= 70) {
        godClassDetails.push(scored);
      }
    }

    const godClassCandidates = godClassDetails.map(
      (g) => `${g.name} (${g.file}) score=${g.score} conf=${Math.round(g.confidence * 100)}%`,
    );

    const deepInheritance = classes
      .filter((c) => inheritanceDepthHint(c.extendsClause) >= 3)
      .map((c) => `${c.name} extends ${c.extendsClause}`);

    const largeBuildMethods: { file: string; line: number; approxLines: number }[] = [];
    let printCallSites = 0;
    let legacyButtonUsages = 0;
    let missingConstCandidates = 0;
    let usesSealedOrFinalClassKeywords = false;
    let usesPatternMatching = false;
    const listMapSetUsage = { list: 0, map: 0, set: 0 };

    for (const file of snapshot.dartFiles) {
      const lines = file.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (/\bprint\s*\(/.test(line) && !file.relativePath.includes('test/')) {
          printCallSites += 1;
        }
        if (/RaisedButton|FlatButton|OutlineButton/.test(line)) {
          legacyButtonUsages += 1;
        }
        if (/\b(List|Map|Set)\s*[<(]/.test(line) || /\bList\./.test(line)) {
          if (/\bList\b/.test(line)) listMapSetUsage.list += 1;
          if (/\bMap\b/.test(line)) listMapSetUsage.map += 1;
          if (/\bSet\b/.test(line)) listMapSetUsage.set += 1;
        }
        if (/^\s*(sealed|final|base)\s+class\b/.test(line)) {
          usesSealedOrFinalClassKeywords = true;
        }
        if (/\bswitch\s*\([^)]+\)\s*\{[^}]*=>/.test(file.content) || /\bcase\s+.+\s*=>/.test(line)) {
          usesPatternMatching = true;
        }
      }

      const buildIdx = lines.findIndex((l) => /Widget\s+build\s*\(/.test(l));
      if (buildIdx >= 0) {
        const approx = estimateMethodLength(lines, buildIdx);
        if (approx >= 80) {
          largeBuildMethods.push({
            file: file.relativePath,
            line: buildIdx + 1,
            approxLines: approx,
          });
        }
      }

      const widgetCtorHits = file.content.match(
        /\b(Text|Icon|SizedBox|Padding|Center|Container|Column|Row)\s*\(/g,
      );
      const constHits = file.content.match(
        /\bconst\s+(Text|Icon|SizedBox|Padding|Center|Container|Column|Row)\s*\(/g,
      );
      const raw = widgetCtorHits?.length ?? 0;
      const withConst = constHits?.length ?? 0;
      if (raw > withConst + 5) {
        missingConstCandidates += raw - withConst;
      }
    }

    const undocumentedWidgets = widgets.filter((w) => !w.docstring).length;

    const facts: CodeQualityFacts = {
      dartFileCount: snapshot.dartFiles.length,
      widgetCount: widgets.length,
      classCount: classes.length,
      mixinCount: mixins.length,
      extensionCount: extensions.length,
      largeClassCandidates,
      godClassCandidates,
      godClassDetails,
      deepInheritance,
      largeBuildMethods,
      printCallSites,
      legacyButtonUsages,
      missingConstCandidates,
      undocumentedWidgets,
      usesSealedOrFinalClassKeywords,
      usesPatternMatching,
      listMapSetUsage,
    };

    if (mixins.length > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'oop',
            code: 'UsesMixins',
            title: 'Project uses mixins',
            description: 'Mixins found — composition-friendly reuse pattern in Dart.',
            evidence: mixins.slice(0, 5).map((m) => `${m.name} at ${m.filePath}:${m.line}`),
            recommendedFix: null,
            officialReference: this.refs.lookupDoc('mixins'),
            dependsOnAst: true,
            confidence: 0.95,
            basis: astOrFallback(ast),
            scoreImpact: 2,
            whyItMatters: 'Mixins enable shared behavior without deep inheritance trees.',
          },
          ast,
        ),
      );
    }

    if (extensions.length > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'oop',
            code: 'UsesExtensions',
            title: 'Project uses extension methods',
            description: 'Extensions add behavior without inheritance.',
            evidence: extensions.slice(0, 5).map((e) => `${e.name} at ${e.filePath}:${e.line}`),
            recommendedFix: null,
            officialReference: this.refs.lookupDoc('extension methods'),
            dependsOnAst: true,
            confidence: 0.95,
            basis: astOrFallback(ast),
            scoreImpact: 2,
          },
          ast,
        ),
      );
    }

    if (largeClassCandidates.length > 0) {
      findings.push(
        finding(
          {
            severity: 'info',
            category: 'solid',
            code: 'LargeClassCandidate',
            title: 'Large class candidates (size signal only)',
            description:
              'Classes in files ≥400 LOC are common in Flutter UI. Size alone is not a god-class verdict — see GodClassCandidate for multi-signal hits.',
            evidence: largeClassCandidates.slice(0, 10),
            recommendedFix:
              'Review the largest files; extract widgets/sections only when responsibilities clearly mix.',
            source: 'heuristic',
            dependsOnAst: true,
            confidence: 0.85,
            basis: astOrFallback(ast),
            scoreImpact: -2,
            whyItMatters:
              'Large screens are often fine; treat LOC as a triage signal, not an automatic defect.',
          },
          ast,
        ),
      );
    }

    if (godClassDetails.length > 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'solid',
            code: 'GodClassCandidate',
            title: 'God class candidates (multi-signal)',
            description:
              'High god-class score from LOC + methods + fields + imports — not size alone.',
            evidence: godClassDetails.slice(0, 10).map(
              (g) =>
                `${g.name} @ ${g.file}: score=${g.score}, conf=${Math.round(g.confidence * 100)}%, signals=${g.signals.join('|')}`,
            ),
            recommendedFix:
              'Split by responsibility (UI sections, state owners, IO). Prefer feature-local widgets/services.',
            source: 'heuristic',
            dependsOnAst: true,
            confidence: Math.min(
              0.95,
              godClassDetails.reduce((s, g) => s + g.confidence, 0) / godClassDetails.length,
            ),
            basis: astOrFallback(ast),
            scoreImpact: -Math.min(15, 6 + Math.floor(godClassDetails.length / 5)),
            whyItMatters:
              'Types that mix many methods, fields, and dependencies concentrate change risk.',
          },
          ast,
        ),
      );
    }

    if (deepInheritance.length > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'oop',
            code: 'DeepInheritance',
            title: 'Deep inheritance chains detected',
            description: 'Prefer composition over deep inheritance when possible.',
            evidence: deepInheritance.slice(0, 10),
            recommendedFix: 'Flatten hierarchies; use mixins/composition for shared behavior.',
            officialReference: this.refs.lookupDoc('composition'),
            dependsOnAst: true,
            confidence: 0.7,
            basis: astOrFallback(ast),
            scoreImpact: -6,
          },
          ast,
        ),
      );
    }

    // NOTE: large-build-method detection intentionally does NOT emit a
    // finding here. PerformanceAnalyzer owns the 'LargeBuildMethod' finding
    // (lib/-scoped, dynamic count-based title/scoreImpact — see
    // DUPLICATE_FINDINGS_AUDIT.md #1). `largeBuildMethods` is still computed
    // and exposed via `facts` because ScoringEngine.scorePerformance() reads
    // it as a fallback when PerformanceFacts aren't available, and
    // analyze_code_quality's `metrics.largeBuildMethods` reports its count.

    if (printCallSites > 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'flutter',
            code: 'DebugPrint',
            title: 'Uses print() in app code',
            description: 'Prefer debugPrint or a logger; print() is noisy in production.',
            evidence: [`${printCallSites} print( call site(s) outside test/`],
            recommendedFix: 'Replace print with debugPrint or structured logging.',
            officialReference: this.refs.lookupSymbol('debugPrint'),
            source: 'filesystem',
            confidence: 0.95,
            basis: 'pattern',
            scoreImpact: -4,
          },
          ast,
        ),
      );
    }

    if (legacyButtonUsages > 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'flutter',
            code: 'LegacyButtonApi',
            title: 'Legacy Material button APIs',
            description: 'RaisedButton/FlatButton/OutlineButton are obsolete.',
            evidence: [`${legacyButtonUsages} occurrence(s)`],
            recommendedFix: 'Migrate to ElevatedButton / TextButton / OutlinedButton.',
            officialReference: this.refs.lookupSymbol('ElevatedButton'),
            source: 'filesystem',
            confidence: 0.98,
            basis: 'pattern',
            scoreImpact: -8,
            whyItMatters: 'Legacy buttons were removed from Material; apps must migrate to compile on modern Flutter.',
          },
          ast,
        ),
      );
    }

    if (missingConstCandidates > 10) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'dart',
            code: 'ConstOpportunities',
            title: 'Many widgets may be const-eligible',
            description: 'Const widgets reduce rebuild work when inputs are compile-time constants.',
            evidence: [`~${missingConstCandidates} non-const common widget constructor calls`],
            recommendedFix: 'Add const to immutable widget constructors where possible.',
            officialReference: this.refs.lookupDoc('const constructors'),
            source: 'heuristic',
            confidence: 0.65,
            basis: 'pattern',
            scoreImpact: -5,
          },
          ast,
        ),
      );
    }

    // NOTE: undocumented-widget detection intentionally does NOT emit a
    // finding here. DocumentationAnalyzer owns the 'UndocumentedWidgets'
    // finding (ratio-scaled title/scoreImpact, confidence reflecting the
    // real AST source — see DUPLICATE_FINDINGS_AUDIT.md #2).
    // `undocumentedWidgets` is still computed and exposed via `facts`.

    if (usesSealedOrFinalClassKeywords) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'dart',
            code: 'ModernClassModifiers',
            title: 'Uses modern Dart class modifiers',
            description: 'sealed/final/base class modifiers improve exhaustiveness and API design.',
            evidence: ['Found sealed/final/base class declarations'],
            recommendedFix: null,
            officialReference: this.refs.lookupDoc('class modifiers'),
            source: 'filesystem',
            confidence: 0.92,
            basis: 'pattern',
            scoreImpact: 3,
          },
          ast,
        ),
      );
    }

    if (usesPatternMatching) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'dart',
            code: 'PatternMatching',
            title: 'Uses pattern matching',
            description: 'Modern switch/patterns improve null-safety and exhaustiveness.',
            evidence: ['Detected pattern-style switch/case usage'],
            recommendedFix: null,
            officialReference: this.refs.lookupDoc('patterns'),
            source: 'heuristic',
            confidence: 0.75,
            basis: 'pattern',
            scoreImpact: 2,
          },
          ast,
        ),
      );
    }

    findings.push(
      finding(
        {
          severity: 'info',
          category: 'data_structures',
          code: 'CollectionUsage',
          title: 'Collection type usage snapshot',
          description: 'Counts of List/Map/Set mentions (heuristic) for structure awareness.',
          evidence: [
            `List≈${listMapSetUsage.list}`,
            `Map≈${listMapSetUsage.map}`,
            `Set≈${listMapSetUsage.set}`,
          ],
          recommendedFix: null,
          source: 'heuristic',
          confidence: 0.7,
          basis: 'pattern',
        },
        ast,
      ),
    );

    // NOTE: analysis_options.yaml presence intentionally does NOT emit a
    // finding here. DocumentationAnalyzer owns this check ('HasAnalysisOptions'
    // / 'MissingAnalysisOptions') — both analyzers were reading the exact
    // same `snapshot.hasAnalysisOptions` flag (see
    // DUPLICATE_FINDINGS_AUDIT.md #3).

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

function scoreGodClass(
  name: string,
  file: { readonly relativePath: string; readonly content: string; readonly lineCount: number; readonly imports: readonly string[] },
): CodeQualityFacts['godClassDetails'][number] {
  const content = file.content;
  const methodCount = (content.match(/\b(void|Future|Widget|String|int|bool|double|dynamic|[A-Z]\w*)\s+[a-z_]\w*\s*\(/g) ?? [])
    .length;
  const fieldCount = (content.match(/^\s*(final|var|late|static)\s+/gm) ?? []).length;
  const importCount = file.imports.length;
  const responsibilityHints =
    Number(/\b(http\.|Dio\(|Firebase|Repository|Provider|Bloc|Cubit|setState)\b/.test(content)) +
    Number(/\b(build\s*\(|Sliver|Form|AnimationController)\b/.test(content)) +
    Number(/\b(SharedPreferences|Hive|Isar|sqflite)\b/i.test(content));

  let score = 0;
  const signals: string[] = [];
  if (file.lineCount >= 400) {
    score += 25;
    signals.push(`loc=${file.lineCount}`);
  }
  if (file.lineCount >= 800) {
    score += 15;
    signals.push('loc>=800');
  }
  if (methodCount >= 20) {
    score += 20;
    signals.push(`methods≈${methodCount}`);
  }
  if (fieldCount >= 15) {
    score += 15;
    signals.push(`fields≈${fieldCount}`);
  }
  if (importCount >= 20) {
    score += 15;
    signals.push(`imports=${importCount}`);
  }
  if (responsibilityHints >= 2) {
    score += 20;
    signals.push(`mixedResponsibilities≈${responsibilityHints}`);
  }

  const confidence = Math.min(0.95, 0.55 + score / 200 + (signals.length >= 3 ? 0.15 : 0));

  return {
    name,
    file: file.relativePath,
    loc: file.lineCount,
    methodCount,
    fieldCount,
    importCount,
    score: Math.min(100, score),
    confidence: Math.round(confidence * 1000) / 1000,
    signals,
  };
}

function inheritanceDepthHint(extendsClause: string | null): number {
  if (!extendsClause) return 0;
  const parts = extendsClause.split(/\s+/).filter(Boolean);
  return Math.min(parts.length, 5);
}

function estimateMethodLength(lines: readonly string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
        if (started && depth <= 0) {
          return i - startIdx + 1;
        }
      }
    }
    if (i - startIdx > 400) {
      return i - startIdx;
    }
  }
  return lines.length - startIdx;
}

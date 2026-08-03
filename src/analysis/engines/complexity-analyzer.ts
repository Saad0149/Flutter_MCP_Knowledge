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
import { finding } from './finding-factory.js';

export interface ComplexityFacts {
  readonly averageFileLoc: number;
  readonly largeFileCount: number;
  readonly largeFileThreshold: number;
  readonly maxFileLoc: number;
  readonly largeFiles: readonly { readonly file: string; readonly loc: number }[];
  readonly estimatedHighComplexityFiles: number;
  readonly deepNestingFileCount: number;
  readonly deepNestingThreshold: number;
  readonly averageImportsPerFile: number;
  readonly highImportFiles: readonly { readonly file: string; readonly imports: number }[];
  readonly widgetLocDistribution: {
    readonly small: number;
    readonly medium: number;
    readonly large: number;
    readonly huge: number;
  };
  readonly multiResponsibilityWidgets: readonly string[];
}

const LARGE_FILE_LOC = 300;
const DEEP_NESTING_THRESHOLD = 6;
const HIGH_IMPORT_THRESHOLD = 12;
const MULTI_RESP_THRESHOLD = 5;

@injectable()
export class ComplexityAnalyzer implements ProjectAnalysisEngine<ComplexityFacts> {
  readonly name = 'complexity';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<ComplexityFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;
    const libFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('lib/'));

    if (libFiles.length === 0) {
      return {
        engine: this.name,
        facts: emptyFacts(),
        findings: [],
        astMeta: ast,
      };
    }

    const totalLoc = libFiles.reduce((s, f) => s + f.lineCount, 0);
    const averageFileLoc = Math.round(totalLoc / libFiles.length);
    const largeFiles = libFiles
      .filter((f) => f.lineCount >= LARGE_FILE_LOC)
      .sort((a, b) => b.lineCount - a.lineCount)
      .slice(0, 20)
      .map((f) => ({ file: f.relativePath, loc: f.lineCount }));

    const maxFileLoc = largeFiles[0]?.loc ?? 0;

    const deepNestingFiles = libFiles.filter((f) => estimateNestingDepth(f) >= DEEP_NESTING_THRESHOLD);
    const deepNestingFileCount = deepNestingFiles.length;

    const estimatedHighComplexityFiles = libFiles.filter(
      (f) => estimateCyclomaticComplexity(f) >= 10,
    ).length;

    const importCounts = libFiles.map((f) => ({
      file: f.relativePath,
      imports: f.imports.length,
    }));
    const totalImports = importCounts.reduce((s, f) => s + f.imports, 0);
    const averageImportsPerFile = Math.round(totalImports / libFiles.length);
    const highImportFiles = importCounts
      .filter((f) => f.imports >= HIGH_IMPORT_THRESHOLD)
      .sort((a, b) => b.imports - a.imports)
      .slice(0, 10);

    const widgets = snapshot.symbols.filter((s) => s.isWidget);
    const widgetLocDistribution = { small: 0, medium: 0, large: 0, huge: 0 };
    for (const w of widgets) {
      const file = snapshot.dartFiles.find((f) => f.relativePath === w.filePath);
      const loc = file?.lineCount ?? 0;
      if (loc < 100) widgetLocDistribution.small++;
      else if (loc < 300) widgetLocDistribution.medium++;
      else if (loc < 600) widgetLocDistribution.large++;
      else widgetLocDistribution.huge++;
    }

    const multiResponsibilityWidgets = detectMultiResponsibilityWidgets(snapshot);

    const facts: ComplexityFacts = {
      averageFileLoc,
      largeFileCount: largeFiles.length,
      largeFileThreshold: LARGE_FILE_LOC,
      maxFileLoc,
      largeFiles,
      estimatedHighComplexityFiles,
      deepNestingFileCount,
      deepNestingThreshold: DEEP_NESTING_THRESHOLD,
      averageImportsPerFile,
      highImportFiles,
      widgetLocDistribution,
      multiResponsibilityWidgets,
    };

    if (largeFiles.length > 0) {
      const ratio = largeFiles.length / libFiles.length;
      findings.push(
        finding(
          {
            severity: ratio > 0.3 ? 'negative' : 'warning',
            category: 'flutter',
            code: 'LargeFiles',
            title: `${largeFiles.length} files exceed ${LARGE_FILE_LOC} LOC`,
            description: `${largeFiles.length} of ${libFiles.length} lib files (${Math.round(ratio * 100)}%) exceed the ${LARGE_FILE_LOC}-line threshold, suggesting overloaded classes or widgets.`,
            evidence: largeFiles.slice(0, 5).map((f) => `${f.file} (${f.loc} lines)`),
            recommendedFix: 'Split large files by responsibility. Extract widgets, state, and data access into separate files.',
            officialReference: this.refs.lookupDoc('widget composition'),
            source: 'filesystem',
            confidence: 0.9,
            scoreImpact: ratio > 0.3 ? -10 : -5,
            whyItMatters: 'Large files concentrate multiple responsibilities, increasing cognitive load and merge conflicts.',
          },
          ast,
        ),
      );
    } else {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'flutter',
            code: 'WellSizedFiles',
            title: 'Files are well-sized (all under 300 LOC)',
            description: 'No lib files exceed the 300-line threshold.',
            evidence: [`libFiles=${libFiles.length}`, `avgLoc=${averageFileLoc}`],
            recommendedFix: null,
            source: 'filesystem',
            confidence: 0.85,
            scoreImpact: 6,
          },
          ast,
        ),
      );
    }

    if (estimatedHighComplexityFiles > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'HighComplexityFiles',
            title: `~${estimatedHighComplexityFiles} files show elevated cyclomatic complexity`,
            description: 'High branching logic (if/else/switch/catch) in single files hinders testing and comprehension.',
            evidence: [`estimatedHighComplexityFiles=${estimatedHighComplexityFiles}`],
            recommendedFix: 'Extract complex conditionals into named methods. Use sealed classes and pattern matching for exhaustive branching.',
            source: 'heuristic',
            confidence: 0.65,
            scoreImpact: -5,
          },
          ast,
        ),
      );
    }

    if (deepNestingFileCount > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'DeepNesting',
            title: `${deepNestingFileCount} files with estimated deep nesting (>${DEEP_NESTING_THRESHOLD} levels)`,
            description: 'Deeply nested widget trees and code blocks reduce readability and increase rebuild surface area.',
            evidence: deepNestingFiles.slice(0, 5).map((f) => f.relativePath),
            recommendedFix: 'Extract inner widgets into named methods or separate widget classes. Flatten nested conditions using early returns.',
            officialReference: this.refs.lookupDoc('widget composition'),
            source: 'heuristic',
            confidence: 0.6,
            scoreImpact: -4,
          },
          ast,
        ),
      );
    }

    if (highImportFiles.length > 0) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'architecture',
            code: 'HighImportCount',
            title: `${highImportFiles.length} files import ${HIGH_IMPORT_THRESHOLD}+ packages`,
            description: 'Files with many imports often mix concerns and become coupling points.',
            evidence: highImportFiles.slice(0, 5).map((f) => `${f.file} (${f.imports} imports)`),
            recommendedFix: 'Apply Single Responsibility — if a file imports many packages, split it along domain boundaries.',
            source: 'import_graph',
            confidence: 0.85,
            scoreImpact: -3,
          },
          ast,
        ),
      );
    }

    if (multiResponsibilityWidgets.length >= MULTI_RESP_THRESHOLD) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'MultiResponsibilityWidgets',
            title: `${multiResponsibilityWidgets.length} widgets mix UI and business logic`,
            description: 'Widgets that contain network calls, database access, or complex transformations violate separation of concerns.',
            evidence: multiResponsibilityWidgets.slice(0, 5),
            recommendedFix: 'Move business logic into controllers, BLoCs, or providers. Keep widgets as pure UI builders.',
            source: 'heuristic',
            confidence: 0.65,
            scoreImpact: -6,
          },
          ast,
        ),
      );
    }

    if (widgetLocDistribution.huge > 0) {
      findings.push(
        finding(
          {
            severity: 'negative',
            category: 'flutter',
            code: 'HugeWidgets',
            title: `${widgetLocDistribution.huge} widget files exceed 600 LOC`,
            description: 'Very large widget files are difficult to navigate, test, and maintain.',
            evidence: [`hugeWidgets=${widgetLocDistribution.huge}`],
            recommendedFix: 'Decompose into smaller widget classes. Each widget should have a single clear visual responsibility.',
            source: 'filesystem',
            confidence: 0.9,
            scoreImpact: -8,
          },
          ast,
        ),
      );
    }

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

function estimateNestingDepth(file: DartFileInfo): number {
  let maxDepth = 0;
  let depth = 0;
  for (const ch of file.content) {
    if (ch === '{') {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return maxDepth;
}

function estimateCyclomaticComplexity(file: DartFileInfo): number {
  const keywords = /\b(if|else|for|while|do|switch|case|catch|&&|\|\||\?)\b/g;
  const matches = file.content.match(keywords);
  return (matches?.length ?? 0);
}

function detectMultiResponsibilityWidgets(snapshot: ProjectSnapshot): string[] {
  const result: string[] = [];
  const mixedPatterns = /http\.|dio\.|Firestore|supabase|sqflite|Repository|Service|ApiClient|Future\.wait|Completer/;
  for (const sym of snapshot.symbols) {
    if (!sym.isWidget) continue;
    const file = snapshot.dartFiles.find((f) => f.relativePath === sym.filePath);
    if (!file) continue;
    if (mixedPatterns.test(file.content)) {
      result.push(`${sym.name} (${sym.filePath})`);
    }
  }
  return result;
}

function emptyFacts(): ComplexityFacts {
  return {
    averageFileLoc: 0,
    largeFileCount: 0,
    largeFileThreshold: LARGE_FILE_LOC,
    maxFileLoc: 0,
    largeFiles: [],
    estimatedHighComplexityFiles: 0,
    deepNestingFileCount: 0,
    deepNestingThreshold: DEEP_NESTING_THRESHOLD,
    averageImportsPerFile: 0,
    highImportFiles: [],
    widgetLocDistribution: { small: 0, medium: 0, large: 0, huge: 0 },
    multiResponsibilityWidgets: [],
  };
}

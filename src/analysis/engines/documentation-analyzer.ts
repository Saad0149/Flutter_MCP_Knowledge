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

export interface DocumentationFacts {
  readonly publicWidgetCount: number;
  readonly documentedWidgetCount: number;
  readonly widgetDocumentationRatio: number;
  readonly publicClassCount: number;
  readonly documentedClassCount: number;
  readonly classDocumentationRatio: number;
  readonly hasReadme: boolean;
  readonly hasAnalysisOptions: boolean;
  readonly pubspecHasDescription: boolean;
  readonly hasChangelog: boolean;
  readonly hasContributing: boolean;
  readonly inlineCommentRatio: number;
  readonly documentationScore: number;
}

@injectable()
export class DocumentationAnalyzer implements ProjectAnalysisEngine<DocumentationFacts> {
  readonly name = 'documentation';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<DocumentationFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;

    const widgets = snapshot.symbols.filter((s) => s.isWidget);
    const publicClasses = snapshot.symbols.filter(
      (s) => s.kind === 'class' && !s.name.startsWith('_'),
    );

    const documentedWidgets = widgets.filter((w) => w.docstring && w.docstring.length > 0);
    const documentedClasses = publicClasses.filter((c) => c.docstring && c.docstring.length > 0);

    const widgetDocRatio =
      widgets.length === 0 ? 1 : documentedWidgets.length / widgets.length;
    const classDocRatio =
      publicClasses.length === 0 ? 1 : documentedClasses.length / publicClasses.length;

    const hasReadme = snapshot.dartFiles.some(
      (f) => /readme/i.test(f.relativePath),
    ) || checkTopLevelFile(snapshot, 'README.md') || checkTopLevelFile(snapshot, 'README');

    const hasChangelog = checkTopLevelFile(snapshot, 'CHANGELOG.md') || checkTopLevelFile(snapshot, 'CHANGELOG');
    const hasContributing = checkTopLevelFile(snapshot, 'CONTRIBUTING.md');

    const pubspecHasDescription =
      snapshot.pubspecRaw != null && /^\s*description:\s*\S.+/m.test(snapshot.pubspecRaw);

    const libFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('lib/'));
    const inlineCommentRatio = computeInlineCommentRatio(libFiles);

    const documentationScore = computeDocScore({
      widgetDocRatio,
      classDocRatio,
      hasReadme,
      hasAnalysisOptions: snapshot.hasAnalysisOptions,
      pubspecHasDescription,
      hasChangelog,
      inlineCommentRatio,
    });

    const facts: DocumentationFacts = {
      publicWidgetCount: widgets.length,
      documentedWidgetCount: documentedWidgets.length,
      widgetDocumentationRatio: Math.round(widgetDocRatio * 100) / 100,
      publicClassCount: publicClasses.length,
      documentedClassCount: documentedClasses.length,
      classDocumentationRatio: Math.round(classDocRatio * 100) / 100,
      hasReadme,
      hasAnalysisOptions: snapshot.hasAnalysisOptions,
      pubspecHasDescription,
      hasChangelog,
      hasContributing,
      inlineCommentRatio: Math.round(inlineCommentRatio * 100) / 100,
      documentationScore,
    };

    const undocumentedWidgets = widgets.length - documentedWidgets.length;
    if (undocumentedWidgets > 0 && widgets.length > 0) {
      const ratio = undocumentedWidgets / widgets.length;
      findings.push(
        finding(
          {
            severity: ratio > 0.5 ? 'negative' : 'warning',
            category: 'flutter',
            code: 'UndocumentedWidgets',
            title: `${undocumentedWidgets} of ${widgets.length} widget(s) lack doc comments`,
            description: `${Math.round(ratio * 100)}% of public widgets are missing Dart doc comments. Well-documented widgets enable better IDE tooling and team onboarding.`,
            evidence: widgets
              .filter((w) => !w.docstring)
              .slice(0, 6)
              .map((w) => `${w.name} (${w.filePath})`),
            recommendedFix: 'Add triple-slash (///) doc comments to all public widgets explaining their purpose and key parameters.',
            officialReference: this.refs.lookupDoc('documentation'),
            source: ast.source,
            confidence: ast.source === 'dart_analyzer' ? 0.92 : 0.7,
            basis: astOrFallback(ast),
            scoreImpact: ratio > 0.5 ? -12 : -6,
            whyItMatters: 'Missing docs make it impossible for IDE to show widget purpose on hover; slows onboarding.',
          },
          ast,
        ),
      );
    } else if (widgets.length > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'flutter',
            code: 'WellDocumentedWidgets',
            title: `All ${widgets.length} public widgets are documented`,
            description: 'Every public widget has a doc comment.',
            evidence: [`documentedWidgets=${documentedWidgets.length}`],
            recommendedFix: null,
            source: ast.source,
            confidence: ast.source === 'dart_analyzer' ? 0.92 : 0.7,
            basis: astOrFallback(ast),
            scoreImpact: 10,
          },
          ast,
        ),
      );
    }

    if (!snapshot.hasAnalysisOptions) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'dart',
            code: 'MissingAnalysisOptions',
            title: 'Missing analysis_options.yaml',
            description: 'analysis_options.yaml configures lints and enforces code standards across the team.',
            evidence: ['analysis_options.yaml not found at project root'],
            recommendedFix: 'Add analysis_options.yaml including package:flutter_lints/flutter.yaml or package:lints/recommended.yaml.',
            source: 'filesystem',
            confidence: 1.0,
            basis: 'ast',
            scoreImpact: -8,
          },
          ast,
        ),
      );
    } else {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'dart',
            code: 'HasAnalysisOptions',
            title: 'analysis_options.yaml is configured',
            description: 'Lint rules are active and enforced.',
            evidence: ['analysis_options.yaml present'],
            recommendedFix: null,
            source: 'filesystem',
            confidence: 1.0,
            basis: 'ast',
            scoreImpact: 8,
          },
          ast,
        ),
      );
    }

    if (!pubspecHasDescription) {
      findings.push(
        finding(
          {
            severity: 'info',
            category: 'other',
            code: 'MissingPubspecDescription',
            title: 'pubspec.yaml lacks a description',
            description: 'A clear description helps collaborators and pub.dev users understand the project.',
            evidence: ['description field is empty or missing'],
            recommendedFix: 'Add a meaningful description to pubspec.yaml.',
            source: 'filesystem',
            confidence: 0.95,
            basis: 'ast',
            scoreImpact: -2,
          },
          ast,
        ),
      );
    }

    if (!hasReadme) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'other',
            code: 'MissingReadme',
            title: 'No README file found',
            description: 'A README is the entry point for contributors and users.',
            evidence: ['README.md not found at project root'],
            recommendedFix: 'Add README.md with setup instructions, architecture overview, and contribution guide.',
            source: 'filesystem',
            confidence: 0.9,
            basis: 'ast',
            scoreImpact: -5,
          },
          ast,
        ),
      );
    }

    if (inlineCommentRatio < 0.03 && libFiles.length > 5) {
      findings.push(
        finding(
          {
            severity: 'info',
            category: 'other',
            code: 'LowInlineComments',
            title: 'Very few inline comments in source code',
            description: `Inline comment ratio is ${Math.round(inlineCommentRatio * 100)}%. Non-obvious business logic benefits from explanatory comments.`,
            evidence: [`commentRatio=${Math.round(inlineCommentRatio * 100)}%`],
            recommendedFix: 'Add inline comments for non-obvious business rules, workarounds, and invariants.',
            source: 'filesystem',
            confidence: 0.8,
            basis: 'pattern',
            scoreImpact: -2,
          },
          ast,
        ),
      );
    }

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

function checkTopLevelFile(snapshot: ProjectSnapshot, name: string): boolean {
  return snapshot.dartFiles.some((f) => {
    const parts = f.relativePath.replaceAll('\\', '/').split('/');
    return parts.length <= 2 && parts[parts.length - 1]?.toLowerCase() === name.toLowerCase();
  });
}

function computeInlineCommentRatio(
  files: readonly { content: string; lineCount: number }[],
): number {
  if (files.length === 0) return 0;
  let totalLines = 0;
  let commentLines = 0;
  for (const f of files) {
    const lines = f.content.split('\n');
    totalLines += lines.length;
    commentLines += lines.filter((l) => /^\s*\/\//.test(l)).length;
  }
  return totalLines === 0 ? 0 : commentLines / totalLines;
}

function computeDocScore(input: {
  widgetDocRatio: number;
  classDocRatio: number;
  hasReadme: boolean;
  hasAnalysisOptions: boolean;
  pubspecHasDescription: boolean;
  hasChangelog: boolean;
  inlineCommentRatio: number;
}): number {
  let score = 30;
  score += Math.round(input.widgetDocRatio * 25);
  score += Math.round(input.classDocRatio * 15);
  if (input.hasReadme) score += 10;
  if (input.hasAnalysisOptions) score += 10;
  if (input.pubspecHasDescription) score += 5;
  if (input.hasChangelog) score += 5;
  score += Math.min(10, Math.round(input.inlineCommentRatio * 200));
  return Math.max(0, Math.min(100, score));
}

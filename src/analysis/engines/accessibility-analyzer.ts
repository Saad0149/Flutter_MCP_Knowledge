import { inject, injectable } from 'tsyringe';
import { TYPES } from '../../types/tokens.js';
import { OfficialReferenceResolver } from '../official-refs.js';
import type {
  AnalysisFinding,
  AnalyzerResult,
  ProjectAnalysisEngine,
  ProjectSnapshot,
} from '../types.js';
import { finding } from './finding-factory.js';

export interface AccessibilityFacts {
  readonly semanticsWidgetCount: number;
  readonly excludeSemanticsCount: number;
  readonly mergeSemanticsTrees: number;
  readonly tooltipUsageCount: number;
  readonly imageWithoutSemanticLabel: number;
  readonly iconButtonWithoutTooltip: number;
  readonly gestureDetectorWithoutSemanticsLabel: number;
  readonly customPainterCount: number;
  readonly accessibilityScore: number;
  readonly libFilesScanned: number;
}

@injectable()
export class AccessibilityAnalyzer implements ProjectAnalysisEngine<AccessibilityFacts> {
  readonly name = 'accessibility';

  constructor(
    @inject(TYPES.OfficialReferenceResolver)
    private readonly refs: OfficialReferenceResolver,
  ) {}

  analyze(snapshot: ProjectSnapshot): AnalyzerResult<AccessibilityFacts> {
    const findings: AnalysisFinding[] = [];
    const ast = snapshot.astMeta;
    const libFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('lib/'));

    let semanticsWidgetCount = 0;
    let excludeSemanticsCount = 0;
    let mergeSemanticsTrees = 0;
    let tooltipUsageCount = 0;
    let imageWithoutSemanticLabel = 0;
    let iconButtonWithoutTooltip = 0;
    let gestureDetectorWithoutSemanticsLabel = 0;
    let customPainterCount = 0;

    for (const file of libFiles) {
      const content = file.content;

      semanticsWidgetCount += count(content, /\bSemantics\s*\(/g);
      excludeSemanticsCount += count(content, /\bExcludeSemantics\s*\(/g);
      mergeSemanticsTrees += count(content, /\bMergeSemantics\s*\(/g);
      tooltipUsageCount += count(content, /\bTooltip\s*\(/g);
      customPainterCount += count(content, /\bCustomPainter\b/g);

      const totalImages = count(content, /\bImage\.(?:network|asset|file|memory)\s*\(/g);
      const labeledImages = count(content, /semanticLabel\s*:/g);
      imageWithoutSemanticLabel += Math.max(0, totalImages - labeledImages);

      const totalIconButtons = count(content, /\bIconButton\s*\(/g);
      const tooltippedIconButtons = count(content, /tooltip\s*:/g);
      iconButtonWithoutTooltip += Math.max(0, totalIconButtons - tooltippedIconButtons);

      const gestureDetectors = count(content, /\bGestureDetector\s*\(/g);
      const gestureWithSemLabel = count(content, /onTap[^,]*semanticsLabel|semanticsLabel[^,]*onTap/g);
      gestureDetectorWithoutSemanticsLabel += Math.max(0, gestureDetectors - gestureWithSemLabel);
    }

    const accessibilityScore = computeAccessibilityScore({
      semanticsWidgetCount,
      tooltipUsageCount,
      imageWithoutSemanticLabel,
      iconButtonWithoutTooltip,
      libFileCount: libFiles.length,
    });

    const facts: AccessibilityFacts = {
      semanticsWidgetCount,
      excludeSemanticsCount,
      mergeSemanticsTrees,
      tooltipUsageCount,
      imageWithoutSemanticLabel,
      iconButtonWithoutTooltip,
      gestureDetectorWithoutSemanticsLabel,
      customPainterCount,
      accessibilityScore,
      libFilesScanned: libFiles.length,
    };

    if (libFiles.length === 0) {
      return { engine: this.name, facts, findings, astMeta: ast };
    }

    const hasAnySemantics =
      semanticsWidgetCount + tooltipUsageCount + mergeSemanticsTrees > 0;

    if (!hasAnySemantics && libFiles.length > 3) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'NoSemanticsWidgets',
            title: 'No Semantics, MergeSemantics, or Tooltip usage detected',
            description: 'No explicit accessibility annotations found. Screen readers and assistive technologies depend on semantic labels.',
            evidence: [`libFiles=${libFiles.length}`, 'Semantics=0', 'Tooltip=0'],
            recommendedFix: 'Wrap interactive elements with Semantics widgets. Add tooltip to all IconButtons. Add semanticLabel to Images.',
            officialReference: this.refs.lookupDoc('accessibility'),
            source: 'filesystem',
            confidence: 0.85,
            scoreImpact: -12,
            whyItMatters: 'Apps without semantic annotations fail WCAG accessibility standards and are unusable with screen readers.',
          },
          ast,
        ),
      );
    } else if (semanticsWidgetCount > 0) {
      findings.push(
        finding(
          {
            severity: 'positive',
            category: 'flutter',
            code: 'SemanticsWidgetsPresent',
            title: `Accessibility annotations found: ${semanticsWidgetCount} Semantics, ${tooltipUsageCount} Tooltips`,
            description: 'Explicit semantic annotations support screen readers and assistive technologies.',
            evidence: [
              `Semantics=${semanticsWidgetCount}`,
              `Tooltip=${tooltipUsageCount}`,
              `MergeSemantics=${mergeSemanticsTrees}`,
            ],
            recommendedFix: null,
            source: 'filesystem',
            confidence: 0.85,
            scoreImpact: 10,
          },
          ast,
        ),
      );
    }

    if (imageWithoutSemanticLabel > 3) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'ImagesWithoutSemanticLabels',
            title: `~${imageWithoutSemanticLabel} Image widget(s) without semanticLabel`,
            description: 'Images without semantic labels are invisible to screen readers.',
            evidence: [`imagesWithoutLabel≈${imageWithoutSemanticLabel}`],
            recommendedFix: 'Add semanticLabel to all meaningful Image widgets. Use excludeFromSemantics: true for decorative images.',
            source: 'heuristic',
            confidence: 0.65,
            scoreImpact: -6,
          },
          ast,
        ),
      );
    }

    if (iconButtonWithoutTooltip > 3) {
      findings.push(
        finding(
          {
            severity: 'warning',
            category: 'flutter',
            code: 'IconButtonsWithoutTooltip',
            title: `~${iconButtonWithoutTooltip} IconButton(s) without tooltip`,
            description: 'IconButtons without tooltips are inaccessible to screen-reader users who cannot see the icon.',
            evidence: [`iconButtonsWithoutTooltip≈${iconButtonWithoutTooltip}`],
            recommendedFix: 'Add a tooltip property to every IconButton describing its action.',
            source: 'heuristic',
            confidence: 0.65,
            scoreImpact: -5,
          },
          ast,
        ),
      );
    }

    if (customPainterCount > 0) {
      findings.push(
        finding(
          {
            severity: 'info',
            category: 'flutter',
            code: 'CustomPainterAccessibility',
            title: `${customPainterCount} CustomPainter(s) detected — verify semantic annotations`,
            description: 'CustomPainters render outside the semantic tree by default; verify that SemanticsBuilder is used where needed.',
            evidence: [`customPainters=${customPainterCount}`],
            recommendedFix: 'Override semanticsBuilder in CustomPainter for interactive painted content.',
            officialReference: this.refs.lookupDoc('CustomPainter semantics'),
            source: 'heuristic',
            confidence: 0.75,
            scoreImpact: -2,
          },
          ast,
        ),
      );
    }

    return { engine: this.name, facts, findings, astMeta: ast };
  }
}

function count(content: string, pattern: RegExp): number {
  return (content.match(pattern) ?? []).length;
}

function computeAccessibilityScore(input: {
  semanticsWidgetCount: number;
  tooltipUsageCount: number;
  imageWithoutSemanticLabel: number;
  iconButtonWithoutTooltip: number;
  libFileCount: number;
}): number {
  if (input.libFileCount === 0) return 50;

  const hasSemantics = input.semanticsWidgetCount + input.tooltipUsageCount > 0;
  let score = hasSemantics ? 60 : 40;

  score += Math.min(15, input.semanticsWidgetCount * 2);
  score += Math.min(10, input.tooltipUsageCount);
  score -= Math.min(20, input.imageWithoutSemanticLabel * 2);
  score -= Math.min(15, input.iconButtonWithoutTooltip * 2);

  return Math.max(0, Math.min(100, score));
}

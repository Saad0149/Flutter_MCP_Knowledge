import { injectable } from 'tsyringe';
import type { ArchitectureFacts, DetectedArchitecture } from '../engines/architecture-analyzer.js';
import type { ArchitectureMatch } from '../types.js';

/**
 * Produces primary + alternative architecture matches with evidence.
 * Does not replace ArchitectureAnalyzer — enriches its facts.
 */
@injectable()
export class ArchitectureMatchEngine {
  match(facts: ArchitectureFacts): {
    readonly detected: ArchitectureMatch;
    readonly alternatives: readonly ArchitectureMatch[];
    readonly missingComponents: readonly string[];
    readonly folderStructure: readonly string[];
    readonly dependencyDirection: string;
  } {
    const candidates = scoreCandidates(facts).sort((a, b) => b.confidence - a.confidence);
    const detected = candidates[0] ?? {
      architecture: facts.detectedArchitecture,
      confidence: facts.confidence,
      evidence: facts.evidence,
    };
    const alternatives = candidates.slice(1, 4);

    const missingComponents: string[] = [];
    if (!facts.hasDomain) missingComponents.push('domain');
    if (!facts.hasData) missingComponents.push('data');
    if (!facts.hasPresentation) missingComponents.push('presentation/ui');
    if (!facts.hasFeatures) missingComponents.push('features');
    if (!facts.hasCore && !facts.hasShared) missingComponents.push('core/shared');

    return {
      detected: {
        architecture: detected.architecture,
        confidence: detected.confidence,
        evidence: detected.evidence,
      },
      alternatives,
      missingComponents,
      folderStructure: facts.libDirs,
      dependencyDirection: facts.dependencyDirectionSummary,
    };
  }
}

function scoreCandidates(facts: ArchitectureFacts): ArchitectureMatch[] {
  const out: ArchitectureMatch[] = [];

  const cleanSignals =
    Number(facts.hasDomain) + Number(facts.hasData) + Number(facts.hasPresentation);
  const cleanViolations =
    Number(facts.presentationImportsData) +
    Number(facts.domainImportsFlutter) +
    Number(facts.domainImportsData);

  if (cleanSignals === 3 && cleanViolations === 0) {
    out.push({
      architecture: facts.hasFeatures ? 'hybrid' : 'clean_architecture',
      confidence: facts.hasFeatures ? 75 : 85,
      evidence: [
        'domain+data+presentation present',
        'no measured Presentation→Data / Domain→Data / Domain→Flutter leaks',
      ],
    });
  } else if (cleanSignals === 3) {
    out.push({
      architecture: 'layered',
      confidence: 70,
      evidence: [
        'domain+data+presentation present',
        `layer violations=${cleanViolations}`,
      ],
    });
    out.push({
      architecture: 'clean_architecture',
      confidence: Math.max(30, 70 - cleanViolations * 15),
      evidence: ['layer folders present but dependency rule violations reduce clean confidence'],
    });
  }

  if (facts.hasFeatures && facts.featureDirCount >= 2) {
    out.push({
      architecture: 'feature_first',
      confidence: 80,
      evidence: [`featureDirCount=${facts.featureDirCount}`, `libDirs=${facts.libDirs.join(',')}`],
    });
  } else if (facts.hasFeatures) {
    out.push({
      architecture: 'package_by_feature',
      confidence: 50,
      evidence: ['features folder present but few feature modules detected'],
    });
  }

  if (facts.hasCore && (facts.hasPresentation || facts.hasData)) {
    out.push({
      architecture: 'layered',
      confidence: 60,
      evidence: ['core + presentation/data signals'],
    });
  }

  if (out.length === 0) {
    out.push({
      architecture: (facts.detectedArchitecture || 'unknown') as DetectedArchitecture,
      confidence: facts.confidence,
      evidence: facts.evidence,
    });
  }

  // Ensure primary analyzer detection is represented
  if (!out.some((c) => c.architecture === facts.detectedArchitecture)) {
    out.unshift({
      architecture: facts.detectedArchitecture,
      confidence: facts.confidence,
      evidence: facts.evidence,
    });
  }

  return dedupeByArchitecture(out);
}

function dedupeByArchitecture(matches: ArchitectureMatch[]): ArchitectureMatch[] {
  const best = new Map<string, ArchitectureMatch>();
  for (const m of matches) {
    const prev = best.get(m.architecture);
    if (!prev || m.confidence > prev.confidence) {
      best.set(m.architecture, m);
    }
  }
  return [...best.values()];
}

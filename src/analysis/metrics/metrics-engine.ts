import { injectable } from 'tsyringe';
import type { ArchitectureFacts } from '../engines/architecture-analyzer.js';
import type { CodeQualityFacts } from '../engines/code-quality-analyzer.js';
import type { StateManagementFacts } from '../engines/state-management-analyzer.js';
import type { ProjectMetrics } from '../types.js';
import type { ProjectSnapshot } from '../types.js';

@injectable()
export class MetricsEngine {
  collect(
    snapshot: ProjectSnapshot,
    extras?: {
      readonly architecture?: ArchitectureFacts;
      readonly codeQuality?: CodeQualityFacts;
      readonly stateManagement?: StateManagementFacts;
    },
  ): ProjectMetrics {
    const libFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('lib/'));
    const testFiles = snapshot.dartFiles.filter((f) => f.relativePath.startsWith('test/'));
    const linesOfCode = snapshot.dartFiles.reduce((sum, f) => sum + f.lineCount, 0);

    return {
      dartFileCount: snapshot.dartFiles.length,
      libFileCount: libFiles.length,
      testFileCount: testFiles.length,
      widgetCount:
        extras?.codeQuality?.widgetCount ??
        snapshot.symbols.filter((s) => s.isWidget).length,
      classCount:
        extras?.codeQuality?.classCount ??
        snapshot.symbols.filter((s) => s.kind === 'class').length,
      mixinCount:
        extras?.codeQuality?.mixinCount ??
        snapshot.symbols.filter((s) => s.kind === 'mixin').length,
      extensionCount:
        extras?.codeQuality?.extensionCount ??
        snapshot.symbols.filter((s) => s.kind === 'extension').length,
      enumCount: snapshot.symbols.filter((s) => s.kind === 'enum').length,
      featureCount: extras?.architecture?.featureDirCount ?? 0,
      packageDependencyCount: snapshot.dependencies.length,
      linesOfCode,
      symbolCount: snapshot.symbols.length,
    };
  }
}

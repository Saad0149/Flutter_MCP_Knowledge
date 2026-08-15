import { injectable } from 'tsyringe';
import type {
  AnalysisFinding,
  FindingCategory,
  ProjectSnapshot,
} from '../types.js';

export interface AnalysisRule {
  readonly id: string;
  readonly categories: readonly FindingCategory[];
  evaluate(snapshot: ProjectSnapshot): readonly AnalysisFinding[];
}

/**
 * Plugin registry for analysis rules.
 * Existing class-based analyzers can be adapted as rule packs.
 */
@injectable()
export class RuleEngine {
  private readonly rules: AnalysisRule[] = [];

  register(rule: AnalysisRule): void {
    if (this.rules.some((r) => r.id === rule.id)) {
      throw new Error(`Analysis rule already registered: ${rule.id}`);
    }
    this.rules.push(rule);
  }

  list(): readonly AnalysisRule[] {
    return this.rules;
  }
}

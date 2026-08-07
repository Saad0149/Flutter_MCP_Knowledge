import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import {
  IntendedBehaviourEngine,
  type IntendedBehaviourHit,
  type IntendedBehaviourResult,
} from '../analysis/insight/intended-behaviour-engine.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';
import { withSizeMetadata, type Sized } from './tool-response-helpers.js';

export const FindIntendedBehaviorInputSchema = z.object({
  topic: z
    .string()
    .min(1)
    .describe('Widget, API, or topic — e.g. "AnimatedContainer" or "keys"'),
  limit: z.number().int().positive().max(40).optional(),
});

export type FindIntendedBehaviorInput = z.infer<typeof FindIntendedBehaviorInputSchema>;

/** Back-compat hit shape (+ new confidence/authority fields). */
export interface IntendedBehaviorHit {
  readonly kind:
    | 'widget_test'
    | 'sample'
    | 'migration'
    | 'cookbook'
    | 'guide'
    | 'changelog'
    | 'source'
    | 'official_docs'
    | 'framework_source'
    | 'framework_tests'
    | 'official_samples'
    | 'migration_guides'
    | 'package_docs'
    | 'community'
    | 'changelog';
  readonly repository: string;
  readonly file: string;
  readonly line: number | null;
  readonly title: string | null;
  readonly snippet: string;
  readonly confidence?: number;
  readonly authority?: 'official' | 'community';
}

export interface FindIntendedBehaviorData {
  readonly topic: string;
  readonly results: readonly IntendedBehaviorHit[];
  readonly searchedSteps: readonly string[];
  readonly exhaustedAllSources: boolean;
  readonly summary: string;
  readonly status: 'ok' | 'empty' | 'blocked' | 'building';
  /** The exact next tool call that would resolve/progress a building/degraded result. */
  readonly suggestedAction?: string;
  readonly knowledgeBase?: {
    readonly available: boolean;
    readonly reason: string;
    readonly expectedSources: readonly string[];
    readonly nextStep: string;
    readonly indexedRepositoryCount: number;
    readonly indexedSymbolCount: number;
    readonly skippedSources?: readonly string[];
  };
}

@injectable()
export class FindIntendedBehaviorHandler {
  constructor(
    @inject(TYPES.IntendedBehaviourEngine)
    private readonly engine: IntendedBehaviourEngine,
  ) {}

  async execute(
    input: FindIntendedBehaviorInput,
  ): Promise<ToolResult<Sized<FindIntendedBehaviorData>>> {
    try {
      const parsed = FindIntendedBehaviorInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for find_intended_behavior',
          details: parsed.error.flatten(),
        });
      }

      const result: IntendedBehaviourResult = await this.engine.search(
        parsed.data.topic.trim(),
        parsed.data.limit ?? 25,
      );

      return toolOk(
        withSizeMetadata({
          topic: result.topic,
          results: result.results.map(mapHit),
          searchedSteps: result.searchedSteps,
          exhaustedAllSources: result.exhaustedAllSources,
          summary: result.summary,
          status: result.status,
          suggestedAction: result.suggestedAction,
          knowledgeBase: result.knowledgeBase,
        }),
      );
    } catch (error) {
      return toolFail(error);
    }
  }
}

function mapHit(hit: IntendedBehaviourHit): IntendedBehaviorHit {
  return {
    kind: mapKind(hit.kind),
    repository: hit.repository,
    file: hit.file,
    line: hit.line,
    title: hit.title,
    snippet: hit.snippet,
    confidence: hit.confidence,
    authority: hit.authority,
  };
}

function mapKind(kind: IntendedBehaviourHit['kind']): IntendedBehaviorHit['kind'] {
  switch (kind) {
    case 'framework_tests':
      return 'widget_test';
    case 'official_samples':
      return 'sample';
    case 'migration_guides':
      return 'migration';
    case 'changelog':
      return 'changelog';
    case 'official_docs':
      return 'guide';
    case 'framework_source':
      return 'source';
    default:
      return kind;
  }
}

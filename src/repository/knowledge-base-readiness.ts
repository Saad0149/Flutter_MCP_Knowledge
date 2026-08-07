import { inject, injectable } from 'tsyringe';
import type { KnowledgeStore } from '../store/types.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import type { QueuedRepoStatus, RepositoryManager, RepositoryStatus } from './types.js';

/** A clone older than this (or never pulled) counts as "critically stale". */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

export interface KnowledgeBaseNotice {
  readonly status: 'building' | 'degraded';
  readonly message: string;
  /** The exact next tool call that would resolve/progress this state. */
  readonly suggestedAction: string;
  readonly skippedSources?: readonly string[];
}

export type KnowledgeBaseReadiness =
  | { readonly state: 'ready' }
  | {
      readonly state: 'building';
      readonly notice: KnowledgeBaseNotice;
      readonly repositories: readonly QueuedRepoStatus[];
    }
  | {
      readonly state: 'degraded';
      readonly notice: KnowledgeBaseNotice;
      readonly skippedSources: readonly string[];
    };

/**
 * Shared readiness gate for every tool that reads from the knowledge base
 * (indexed repos/symbols/docs). Rather than each tool silently returning an
 * empty result when nothing is cloned/indexed yet, this triggers the same
 * non-blocking background clone (RepositoryManager.startBackgroundUpdate,
 * already used by update_repositories) and reports back immediately so
 * callers can retry shortly instead of assuming "no matches".
 */
@injectable()
export class KnowledgeBaseReadinessChecker {
  constructor(
    @inject(TYPES.RepositoryManager) private readonly repositories: RepositoryManager,
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async check(): Promise<KnowledgeBaseReadiness> {
    const statuses = await this.repositories.getStatus();
    const definitions = this.repositories.listDefinitions();
    const now = Date.now();

    const existing = statuses.filter((status) => status.exists);
    const anyCloning = statuses.some((status) => status.cloneInProgress);
    const stale = existing.filter((status) => isStale(status, now));
    const noReposCloned = existing.length === 0;
    const criticallyStale = existing.length > 0 && stale.length === existing.length;

    if (anyCloning || noReposCloned || criticallyStale) {
      const queued = this.repositories.startBackgroundUpdate();
      this.logger.info('Auto-bootstrapping knowledge base repositories', {
        reason: noReposCloned ? 'no_repos_cloned' : criticallyStale ? 'critically_stale' : 'clone_in_progress',
        queued: queued.length,
      });

      return {
        state: 'building',
        repositories: queued,
        notice: {
          status: 'building',
          message:
            'Knowledge base is being built in the background — this may take a few minutes on first use. Try again shortly, or call repository_status to check progress.',
          suggestedAction: 'Call repository_status to check progress.',
        },
      };
    }

    const missing = definitions
      .map((definition) => definition.name)
      .filter((name) => !existing.some((status) => status.name === name));
    const skippedSources = [...new Set([...missing, ...stale.map((status) => status.name)])];

    const indexStats = this.store.getStats();
    if (indexStats.symbolCount === 0 && indexStats.docCount === 0) {
      return {
        state: 'degraded',
        skippedSources,
        notice: {
          status: 'degraded',
          message:
            'Repositories are cloned but not yet indexed, so knowledge-base lookups currently return no results.',
          suggestedAction: 'Call reindex to build the searchable index from the cloned repositories.',
          skippedSources,
        },
      };
    }

    if (skippedSources.length > 0) {
      return {
        state: 'degraded',
        skippedSources,
        notice: {
          status: 'degraded',
          message: `Knowledge base is partially built — ${skippedSources.length} source(s) missing or stale: ${skippedSources.join(', ')}.`,
          suggestedAction: 'Call update_repositories to fetch the missing/stale sources, then reindex.',
          skippedSources,
        },
      };
    }

    return { state: 'ready' };
  }
}

function isStale(status: RepositoryStatus, now: number): boolean {
  if (!status.lastPull) {
    return true;
  }
  return now - new Date(status.lastPull).getTime() > STALE_MS;
}

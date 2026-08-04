export interface RepositoryDefinition {
  /** Stable identifier used by tools, e.g. "flutter/flutter" */
  readonly name: string;
  /** Local directory name under repositoriesRoot */
  readonly localName: string;
  /** HTTPS clone URL (git only; no GitHub API) */
  readonly cloneUrl: string;
  /** Default remote branch to track */
  readonly defaultBranch: string;
}

export type UpdateOutcome = 'cloned' | 'updated' | 'already_up_to_date' | 'error' | 'in_progress';

export interface RepositoryStatus {
  readonly name: string;
  readonly exists: boolean;
  readonly path: string;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly lastPull: string | null;
  /** True while a background clone/pull is running for this repo. */
  readonly cloneInProgress?: boolean;
}

/** Per-repo result returned immediately by startBackgroundUpdate. */
export interface QueuedRepoStatus {
  readonly name: string;
  /** 'queued' = just started; 'in_progress' = was already running. */
  readonly status: 'queued' | 'in_progress';
  readonly path: string;
}

export interface UpdateResult {
  readonly name: string;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly status: UpdateOutcome;
  readonly path: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface RepositoryManager {
  ensureRoot(): Promise<void>;
  /** Blocking update of all repos (bounded concurrency). Used by tests / manual callers. */
  updateAll(): Promise<UpdateResult[]>;
  updateOne(name: string): Promise<UpdateResult>;
  /**
   * Non-blocking: fires clone/pull work in the background and returns immediately.
   * If a repo is already mid-clone, it is skipped (reported as 'in_progress').
   * Poll repository_status to observe completion.
   */
  startBackgroundUpdate(): QueuedRepoStatus[];
  getStatus(name?: string): Promise<RepositoryStatus[]>;
  getRepositoryPath(name: string): string;
  listDefinitions(): readonly RepositoryDefinition[];
  resolveDefinition(name: string): RepositoryDefinition;
}

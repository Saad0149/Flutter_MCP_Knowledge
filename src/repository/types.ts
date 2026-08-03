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

export type UpdateOutcome = 'cloned' | 'updated' | 'already_up_to_date' | 'error';

export interface RepositoryStatus {
  readonly name: string;
  readonly exists: boolean;
  readonly path: string;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly lastPull: string | null;
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
  updateAll(): Promise<UpdateResult[]>;
  updateOne(name: string): Promise<UpdateResult>;
  getStatus(name?: string): Promise<RepositoryStatus[]>;
  getRepositoryPath(name: string): string;
  listDefinitions(): readonly RepositoryDefinition[];
  resolveDefinition(name: string): RepositoryDefinition;
}

import { mkdir, access, constants, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inject, injectable } from 'tsyringe';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { AppError } from '../utils/errors.js';
import type {
  QueuedRepoStatus,
  RepositoryDefinition,
  RepositoryManager,
  RepositoryStatus,
  UpdateOutcome,
  UpdateResult,
} from './types.js';

interface MetadataFile {
  readonly lastPull: string | null;
}

/** Maximum simultaneous git clone/pull operations. */
const CLONE_CONCURRENCY = 3;

@injectable()
export class GitRepositoryManager implements RepositoryManager {
  /** Names of repos whose clone/pull is currently running in the background. */
  private readonly inProgressSet = new Set<string>();

  constructor(
    @inject(TYPES.Config) private readonly config: AppConfig,
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.RepositoryDefinitions)
    private readonly definitions: readonly RepositoryDefinition[],
  ) {}

  listDefinitions(): readonly RepositoryDefinition[] {
    return this.definitions;
  }

  resolveDefinition(name: string): RepositoryDefinition {
    const definition = this.definitions.find(
      (repo) => repo.name === name || repo.localName === name,
    );

    if (!definition) {
      throw new AppError(
        'RepositoryNotFound',
        `Unknown repository "${name}". Supported: ${this.definitions.map((r) => r.name).join(', ')}`,
      );
    }

    return definition;
  }

  getRepositoryPath(name: string): string {
    const definition = this.resolveDefinition(name);
    return path.join(this.config.repositoriesRoot, definition.localName);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.config.repositoriesRoot, { recursive: true });
  }

  /**
   * Blocking update of all repos with bounded concurrency.
   * Preserves per-repo failure isolation — one failure does not abort others.
   */
  async updateAll(): Promise<UpdateResult[]> {
    await this.ensureRoot();
    const results: UpdateResult[] = [];
    const queue = [...this.definitions];

    const workers = Array.from(
      { length: Math.min(CLONE_CONCURRENCY, queue.length || 1) },
      async () => {
        for (;;) {
          const def = queue.shift();
          if (!def) break;
          try {
            results.push(await this.updateRepository(def));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof AppError ? error.code : 'GitError';

            this.logger.error('Failed to update repository', {
              repository: def.name,
              error: message,
            });

            results.push({
              name: def.name,
              branch: null,
              commit: null,
              status: 'error',
              path: this.getRepositoryPath(def.name),
              error: { code, message },
            });
          }
        }
      },
    );

    await Promise.all(workers);
    return results;
  }

  async updateOne(name: string): Promise<UpdateResult> {
    await this.ensureRoot();
    return this.updateRepository(this.resolveDefinition(name));
  }

  /**
   * Non-blocking: enqueues clone/pull work for all repos and returns immediately.
   * Repos already mid-clone are reported as 'in_progress' and not started again.
   * Call repository_status to observe progress.
   */
  startBackgroundUpdate(): QueuedRepoStatus[] {
    const statuses: QueuedRepoStatus[] = [];
    const toStart: RepositoryDefinition[] = [];

    for (const def of this.definitions) {
      const repoPath = this.getRepositoryPath(def.name);
      if (this.inProgressSet.has(def.name)) {
        statuses.push({ name: def.name, status: 'in_progress', path: repoPath });
      } else {
        this.inProgressSet.add(def.name);
        toStart.push(def);
        statuses.push({ name: def.name, status: 'queued', path: repoPath });
      }
    }

    if (toStart.length > 0) {
      void this.runBounded(toStart);
    }

    return statuses;
  }

  async getStatus(name?: string): Promise<RepositoryStatus[]> {
    await this.ensureRoot();

    const targets = name ? [this.resolveDefinition(name)] : [...this.definitions];
    const statuses: RepositoryStatus[] = [];

    for (const definition of targets) {
      statuses.push(await this.readStatus(definition));
    }

    return statuses;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Worker-pool executor: runs up to CLONE_CONCURRENCY tasks simultaneously.
   * Used by startBackgroundUpdate; removes each repo from inProgressSet when done.
   */
  private async runBounded(definitions: RepositoryDefinition[]): Promise<void> {
    await this.ensureRoot();
    const queue = [...definitions];

    const workers = Array.from(
      { length: Math.min(CLONE_CONCURRENCY, queue.length) },
      async () => {
        for (;;) {
          const def = queue.shift();
          if (!def) break;
          try {
            await this.updateRepository(def);
          } catch (error) {
            this.logger.error('Background update failed', {
              repository: def.name,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            this.inProgressSet.delete(def.name);
          }
        }
      },
    );

    await Promise.all(workers);
  }

  private async updateRepository(definition: RepositoryDefinition): Promise<UpdateResult> {
    const repoPath = this.getRepositoryPath(definition.name);
    const exists = await this.pathExists(repoPath);

    this.logger.info(exists ? 'Updating repository' : 'Cloning repository', {
      repository: definition.name,
      path: repoPath,
    });

    let outcome: UpdateOutcome;

    try {
      if (!exists) {
        await this.cloneRepository(definition, repoPath);
        outcome = 'cloned';
      } else {
        outcome = await this.pullRepository(repoPath);
      }
    } catch (error) {
      throw new AppError(
        'GitError',
        `Git operation failed for ${definition.name}`,
        error instanceof Error ? error.message : error,
      );
    }

    const now = new Date().toISOString();
    await this.writeMetadata(repoPath, { lastPull: now });

    const git = this.git(repoPath);
    const branch = await this.safeCurrentBranch(git);
    const commit = await this.safeCommit(git);

    this.logger.info('Repository update complete', {
      repository: definition.name,
      status: outcome,
      branch,
      commit,
    });

    return {
      name: definition.name,
      branch,
      commit,
      status: outcome,
      path: repoPath,
    };
  }

  private async cloneRepository(
    definition: RepositoryDefinition,
    repoPath: string,
  ): Promise<void> {
    await mkdir(path.dirname(repoPath), { recursive: true });
    const git = simpleGit();
    await git.clone(definition.cloneUrl, repoPath, [
      '--depth',
      '1',
      '--branch',
      definition.defaultBranch,
      '--single-branch',
    ]);
  }

  private async pullRepository(repoPath: string): Promise<UpdateOutcome> {
    const git = this.git(repoPath);
    const before = await this.safeCommit(git);
    await git.pull();
    const after = await this.safeCommit(git);

    if (before && after && before === after) {
      return 'already_up_to_date';
    }

    return 'updated';
  }

  private async readStatus(definition: RepositoryDefinition): Promise<RepositoryStatus> {
    const repoPath = this.getRepositoryPath(definition.name);
    const exists = await this.pathExists(repoPath);
    const cloneInProgress = this.inProgressSet.has(definition.name);

    if (!exists) {
      return {
        name: definition.name,
        exists: false,
        path: repoPath,
        branch: null,
        commit: null,
        lastPull: null,
        cloneInProgress,
      };
    }

    const git = this.git(repoPath);
    const metadata = await this.readMetadata(repoPath);

    return {
      name: definition.name,
      exists: true,
      path: repoPath,
      branch: await this.safeCurrentBranch(git),
      commit: await this.safeCommit(git),
      lastPull: metadata.lastPull,
      cloneInProgress,
    };
  }

  private git(repoPath: string): SimpleGit {
    return simpleGit({ baseDir: repoPath });
  }

  private async safeCurrentBranch(git: SimpleGit): Promise<string | null> {
    try {
      return await git.revparse(['--abbrev-ref', 'HEAD']);
    } catch {
      return null;
    }
  }

  private async safeCommit(git: SimpleGit): Promise<string | null> {
    try {
      return await git.revparse(['HEAD']);
    } catch {
      return null;
    }
  }

  private metadataPath(repoPath: string): string {
    return path.join(repoPath, '.flutter-knowledge-meta.json');
  }

  private async readMetadata(repoPath: string): Promise<MetadataFile> {
    try {
      const raw = await readFile(this.metadataPath(repoPath), 'utf8');
      const parsed = JSON.parse(raw) as MetadataFile;
      return { lastPull: parsed.lastPull ?? null };
    } catch {
      return { lastPull: null };
    }
  }

  private async writeMetadata(repoPath: string, metadata: MetadataFile): Promise<void> {
    await writeFile(this.metadataPath(repoPath), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await access(target, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

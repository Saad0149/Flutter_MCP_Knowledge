import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { inject, injectable } from 'tsyringe';
import type { AppConfig } from '../../config/schema.js';
import type { Logger } from '../../types/logger.js';
import { TYPES } from '../../types/tokens.js';
import { AppError } from '../../utils/errors.js';
import type { ProjectAnalysisReport } from '../insight/project-report-builder.js';
import { ProjectReportBuilder } from '../insight/project-report-builder.js';

export interface StoredAnalysisSession {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly projectPath: string;
  readonly report: Omit<ProjectAnalysisReport, 'snapshot'>;
}

/**
 * Persists full analysis reports so follow-up MCP tools query the cache
 * instead of rescanning the project.
 */
@injectable()
export class AnalysisSessionStore {
  constructor(
    @inject(TYPES.Config) private readonly config: AppConfig,
    @inject(TYPES.ProjectReportBuilder) private readonly reports: ProjectReportBuilder,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  sessionsDir(): string {
    const configured = (this.config as AppConfig & { sessionsPath?: string }).sessionsPath;
    if (configured) {
      return path.resolve(configured);
    }
    const indexDir = path.dirname(path.resolve(this.config.indexPath));
    return path.join(indexDir, 'analysis-sessions');
  }

  async save(report: ProjectAnalysisReport): Promise<StoredAnalysisSession> {
    const sessionId = randomUUID().replace(/-/g, '').slice(0, 16);
    const { snapshot: _snap, ...rest } = report;
    const stored: StoredAnalysisSession = {
      sessionId,
      createdAt: new Date().toISOString(),
      projectPath: report.projectPath,
      report: rest,
    };

    const dir = this.sessionsDir();
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.json`);
    await writeFile(file, JSON.stringify(stored), 'utf8');

    // Also write a latest pointer per project for convenience
    const latestKey = createHash('sha1').update(report.projectPath).digest('hex').slice(0, 12);
    await writeFile(path.join(dir, `latest-${latestKey}.json`), JSON.stringify({ sessionId }), 'utf8');

    this.logger.info('Analysis session saved', {
      sessionId,
      projectPath: report.projectPath,
      findings: report.findings.length,
    });

    return stored;
  }

  async get(sessionId: string): Promise<StoredAnalysisSession> {
    const file = path.join(this.sessionsDir(), `${sessionId}.json`);
    try {
      const raw = await readFile(file, 'utf8');
      return JSON.parse(raw) as StoredAnalysisSession;
    } catch {
      throw new AppError(
        'InvalidArguments',
        `Analysis session not found: ${sessionId}. Run review_project first.`,
      );
    }
  }

  /**
   * Resolve a report from sessionId (preferred) or by analyzing path.
   * When both are provided, sessionId wins.
   */
  async resolve(input: {
    readonly sessionId?: string;
    readonly path?: string;
    readonly limit?: number;
    readonly forceRefresh?: boolean;
  }): Promise<{ session: StoredAnalysisSession; fromCache: boolean }> {
    if (input.sessionId && !input.forceRefresh) {
      const session = await this.get(input.sessionId);
      return { session, fromCache: true };
    }

    if (!input.path) {
      throw new AppError(
        'InvalidArguments',
        'Provide sessionId (from review_project) or path to analyze.',
      );
    }

    const report = await this.reports.build(input.path, input.limit ?? 200);
    const session = await this.save(report);
    return { session, fromCache: false };
  }

  async pruneOlderThan(maxAgeMs: number): Promise<number> {
    const dir = this.sessionsDir();
    let removed = 0;
    try {
      const files = await readdir(dir);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith('.json') || file.startsWith('latest-')) continue;
        const full = path.join(dir, file);
        try {
          const raw = await readFile(full, 'utf8');
          const parsed = JSON.parse(raw) as StoredAnalysisSession;
          if (now - Date.parse(parsed.createdAt) > maxAgeMs) {
            await unlink(full);
            removed += 1;
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // dir missing
    }
    return removed;
  }
}

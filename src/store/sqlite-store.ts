import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { injectable } from 'tsyringe';
import type {
  DocKind,
  DocSearchHit,
  FileRecord,
  IndexStats,
  InsertDocInput,
  InsertSymbolInput,
  KnowledgeStore,
  RepositoryRecord,
  SymbolSearchHit,
  UpsertFileInput,
  UpsertRepositoryInput,
} from './types.js';

export const SCHEMA_VERSION = 2;

@injectable()
export class SqliteKnowledgeStore implements KnowledgeStore {
  private db: Database.Database | null = null;

  constructor(private readonly dbPath: string) {}

  open(): void {
    if (this.db) {
      return;
    }

    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    if (!this.db) {
      return;
    }
    this.db.close();
    this.db = null;
  }

  getStats(): IndexStats {
    const db = this.requireDb();
    const repositoryCount = (
      db.prepare('SELECT COUNT(*) AS c FROM repositories').get() as { c: number }
    ).c;
    const fileCount = (db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c;
    const symbolCount = (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }).c;
    const docCount = (db.prepare('SELECT COUNT(*) AS c FROM docs').get() as { c: number }).c;

    return {
      schemaVersion: Number(this.getMeta('schema_version') ?? SCHEMA_VERSION),
      lastFullIndex: this.getMeta('last_full_index'),
      repositoryCount,
      fileCount,
      symbolCount,
      docCount,
    };
  }

  setMeta(key: string, value: string): void {
    this.requireDb()
      .prepare(
        `INSERT INTO index_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.requireDb()
      .prepare('SELECT value FROM index_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  upsertRepository(input: UpsertRepositoryInput): RepositoryRecord {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO repositories (name, path, commit_hash, indexed_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(name) DO UPDATE SET
         path = excluded.path,
         commit_hash = excluded.commit_hash`,
    ).run(input.name, input.path, input.commitHash);

    const record = this.getRepositoryByName(input.name);
    if (!record) {
      throw new Error(`Failed to upsert repository ${input.name}`);
    }
    return record;
  }

  getRepositoryByName(name: string): RepositoryRecord | null {
    const row = this.requireDb()
      .prepare(
        `SELECT id, name, path, commit_hash AS commitHash, indexed_at AS indexedAt
         FROM repositories WHERE name = ?`,
      )
      .get(name) as
      | {
          id: number;
          name: string;
          path: string;
          commitHash: string | null;
          indexedAt: string | null;
        }
      | undefined;

    return row ?? null;
  }

  listRepositories(): readonly RepositoryRecord[] {
    return this.requireDb()
      .prepare(
        `SELECT id, name, path, commit_hash AS commitHash, indexed_at AS indexedAt
         FROM repositories ORDER BY name`,
      )
      .all() as RepositoryRecord[];
  }

  markRepositoryIndexed(id: number, commitHash: string | null): void {
    this.requireDb()
      .prepare(
        `UPDATE repositories
         SET commit_hash = ?, indexed_at = ?
         WHERE id = ?`,
      )
      .run(commitHash, new Date().toISOString(), id);
  }

  getFileByPath(repositoryId: number, relativePath: string): FileRecord | null {
    const row = this.requireDb()
      .prepare(
        `SELECT id, repository_id AS repositoryId, path, kind, hash, mtime_ms AS mtimeMs
         FROM files WHERE repository_id = ? AND path = ?`,
      )
      .get(repositoryId, relativePath) as FileRecord | undefined;
    return row ?? null;
  }

  listFiles(repositoryId: number): readonly FileRecord[] {
    return this.requireDb()
      .prepare(
        `SELECT id, repository_id AS repositoryId, path, kind, hash, mtime_ms AS mtimeMs
         FROM files WHERE repository_id = ?`,
      )
      .all(repositoryId) as FileRecord[];
  }

  upsertFile(input: UpsertFileInput): FileRecord {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO files (repository_id, path, kind, hash, mtime_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repository_id, path) DO UPDATE SET
         kind = excluded.kind,
         hash = excluded.hash,
         mtime_ms = excluded.mtime_ms`,
    ).run(input.repositoryId, input.path, input.kind, input.hash, input.mtimeMs);

    const record = this.getFileByPath(input.repositoryId, input.path);
    if (!record) {
      throw new Error(`Failed to upsert file ${input.path}`);
    }
    return record;
  }

  deleteFile(fileId: number): void {
    this.requireDb().prepare('DELETE FROM files WHERE id = ?').run(fileId);
  }

  deleteFilesNotIn(repositoryId: number, relativePaths: readonly string[]): number {
    const existing = this.listFiles(repositoryId);
    const keep = new Set(relativePaths);
    let deleted = 0;
    const del = this.requireDb().prepare('DELETE FROM files WHERE id = ?');
    for (const file of existing) {
      if (!keep.has(file.path)) {
        del.run(file.id);
        deleted += 1;
      }
    }
    return deleted;
  }

  replaceSymbolsForFile(fileId: number, symbols: readonly InsertSymbolInput[]): void {
    const db = this.requireDb();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
      const insert = db.prepare(
        `INSERT INTO symbols (
           file_id, name, kind, line, is_widget, is_widget_test, docstring, package_name,
           extends_clause, with_clause, implements_clause
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const symbol of symbols) {
        insert.run(
          fileId,
          symbol.name,
          symbol.kind,
          symbol.line,
          symbol.isWidget ? 1 : 0,
          symbol.isWidgetTest ? 1 : 0,
          symbol.docstring,
          symbol.packageName,
          symbol.extendsClause ?? null,
          symbol.withClause ?? null,
          symbol.implementsClause ?? null,
        );
      }
    });
    tx();
  }

  replaceDocsForFile(fileId: number, docs: readonly InsertDocInput[]): void {
    const db = this.requireDb();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM docs WHERE file_id = ?').run(fileId);
      const insert = db.prepare(
        `INSERT INTO docs (file_id, title, chunk, line_start, doc_kind) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const doc of docs) {
        insert.run(fileId, doc.title, doc.chunk, doc.lineStart, doc.docKind ?? 'general');
      }
    });
    tx();
  }

  findSymbols(options: {
    readonly name?: string;
    readonly nameContains?: string;
    readonly isWidget?: boolean;
    readonly isWidgetTest?: boolean;
    readonly repositoryName?: string;
    readonly kind?: string;
    readonly underTest?: boolean;
    readonly underExample?: boolean;
    readonly limit?: number;
  }): readonly SymbolSearchHit[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.name) {
      clauses.push('s.name = ?');
      params.push(options.name);
    }
    if (options.nameContains) {
      clauses.push('LOWER(s.name) LIKE ?');
      params.push(`%${options.nameContains.toLowerCase()}%`);
    }
    if (options.isWidget !== undefined) {
      clauses.push('s.is_widget = ?');
      params.push(options.isWidget ? 1 : 0);
    }
    if (options.isWidgetTest !== undefined) {
      clauses.push('s.is_widget_test = ?');
      params.push(options.isWidgetTest ? 1 : 0);
    }
    if (options.repositoryName) {
      clauses.push('r.name = ?');
      params.push(options.repositoryName);
    }
    if (options.kind) {
      clauses.push('s.kind = ?');
      params.push(options.kind);
    }
    if (options.underTest) {
      clauses.push(`(f.path LIKE '%/test/%' OR f.path LIKE '%_test.dart')`);
    }
    if (options.underExample) {
      clauses.push(
        `(f.path LIKE '%/example/%' OR f.path LIKE '%/examples/%' OR r.name = 'flutter/samples')`,
      );
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    params.push(limit);

    const rows = this.requireDb()
      .prepare(
        `SELECT
           s.id AS symbolId,
           s.name AS name,
           s.kind AS kind,
           s.line AS line,
           s.is_widget AS isWidgetInt,
           s.is_widget_test AS isWidgetTestInt,
           s.docstring AS docstring,
           s.package_name AS packageName,
           s.extends_clause AS extendsClause,
           s.with_clause AS withClause,
           s.implements_clause AS implementsClause,
           f.path AS filePath,
           r.name AS repositoryName,
           r.path AS repositoryPath
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         JOIN repositories r ON r.id = f.repository_id
         ${where}
         ORDER BY
           CASE WHEN s.is_widget_test = 1 THEN 0 ELSE 1 END,
           CASE WHEN f.path LIKE '%/test/%' OR f.path LIKE '%_test.dart' THEN 1 ELSE 0 END,
           s.line ASC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      symbolId: row.symbolId as number,
      name: row.name as string,
      kind: row.kind as SymbolSearchHit['kind'],
      line: row.line as number,
      isWidget: Boolean(row.isWidgetInt),
      isWidgetTest: Boolean(row.isWidgetTestInt),
      docstring: (row.docstring as string | null) ?? null,
      packageName: (row.packageName as string | null) ?? null,
      extendsClause: (row.extendsClause as string | null) ?? null,
      withClause: (row.withClause as string | null) ?? null,
      implementsClause: (row.implementsClause as string | null) ?? null,
      filePath: row.filePath as string,
      repositoryName: row.repositoryName as string,
      repositoryPath: row.repositoryPath as string,
    }));
  }

  findDocs(options: {
    readonly query: string;
    readonly repositoryName?: string;
    readonly docKind?: DocKind;
    readonly docKinds?: readonly DocKind[];
    readonly limit?: number;
  }): readonly DocSearchHit[] {
    const clauses = ["(LOWER(d.chunk) LIKE ? OR LOWER(COALESCE(d.title, '')) LIKE ?)"];
    const like = `%${options.query.toLowerCase()}%`;
    const params: unknown[] = [like, like];

    if (options.repositoryName) {
      clauses.push('r.name = ?');
      params.push(options.repositoryName);
    }
    if (options.docKind) {
      clauses.push('d.doc_kind = ?');
      params.push(options.docKind);
    }
    if (options.docKinds && options.docKinds.length > 0) {
      clauses.push(`d.doc_kind IN (${options.docKinds.map(() => '?').join(', ')})`);
      params.push(...options.docKinds);
    }

    const limit = options.limit ?? 50;
    params.push(limit);

    const rows = this.requireDb()
      .prepare(
        `SELECT
           d.id AS docId,
           d.title AS title,
           d.chunk AS chunk,
           d.line_start AS lineStart,
           d.doc_kind AS docKind,
           f.path AS filePath,
           r.name AS repositoryName
         FROM docs d
         JOIN files f ON f.id = d.file_id
         JOIN repositories r ON r.id = f.repository_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY
           CASE d.doc_kind
             WHEN 'migration' THEN 0
             WHEN 'cookbook' THEN 1
             WHEN 'changelog' THEN 2
             WHEN 'guide' THEN 3
             ELSE 4
           END,
           d.line_start ASC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      docId: row.docId as number,
      title: (row.title as string | null) ?? null,
      chunk: row.chunk as string,
      lineStart: row.lineStart as number,
      docKind: (row.docKind as DocKind) ?? 'general',
      filePath: row.filePath as string,
      repositoryName: row.repositoryName as string,
    }));
  }

  getSymbolByName(
    name: string,
    options?: { readonly isWidget?: boolean; readonly repositoryName?: string },
  ): SymbolSearchHit | null {
    const hits = this.findSymbols({
      name,
      isWidget: options?.isWidget,
      repositoryName: options?.repositoryName,
      limit: 1,
    });
    return hits[0] ?? null;
  }

  /** Exposed for tests that need raw access. */
  getDatabase(): Database.Database {
    return this.requireDb();
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('KnowledgeStore is not open. Call open() first.');
    }
    return this.db;
  }

  private migrate(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        commit_hash TEXT,
        indexed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        hash TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        UNIQUE(repository_id, path)
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        is_widget INTEGER NOT NULL DEFAULT 0,
        is_widget_test INTEGER NOT NULL DEFAULT 0,
        docstring TEXT,
        package_name TEXT,
        extends_clause TEXT,
        with_clause TEXT,
        implements_clause TEXT
      );

      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        title TEXT,
        chunk TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        doc_kind TEXT NOT NULL DEFAULT 'general'
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_widget ON symbols(is_widget);
      CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repository_id);
      CREATE INDEX IF NOT EXISTS idx_docs_file ON docs(file_id);
    `);

    // Existing Phase 2 DBs were created without these columns; add before indexing them.
    this.ensureColumn('symbols', 'is_widget_test', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('docs', 'doc_kind', "TEXT NOT NULL DEFAULT 'general'");

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_symbols_widget_test ON symbols(is_widget_test);
      CREATE INDEX IF NOT EXISTS idx_docs_kind ON docs(doc_kind);
    `);

    const current = Number(this.getMeta('schema_version') ?? '0');
    if (current < SCHEMA_VERSION) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const db = this.requireDb();
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) {
      return;
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Factory used by DI so the db path comes from config. */
export function createSqliteKnowledgeStore(dbPath: string): SqliteKnowledgeStore {
  const store = new SqliteKnowledgeStore(dbPath);
  store.open();
  return store;
}

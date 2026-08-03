export type { KnowledgeStore } from './types.js';
export type {
  DocKind,
  DocSearchHit,
  FileKind,
  FileRecord,
  IndexStats,
  InsertDocInput,
  InsertSymbolInput,
  RepositoryRecord,
  SymbolKind,
  SymbolRecord,
  SymbolSearchHit,
} from './types.js';
export { SCHEMA_VERSION, SqliteKnowledgeStore, createSqliteKnowledgeStore } from './sqlite-store.js';

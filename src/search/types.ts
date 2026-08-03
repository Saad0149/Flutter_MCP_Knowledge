/**
 * Search engine abstraction.
 * Phase 1: filesystem grep via FastGlob + line scan.
 * Later phases may swap in an indexed / AST-backed implementation
 * without changing tool handlers.
 */

export interface SearchQuery {
  readonly query: string;
  /** Optional repository name filter, e.g. "flutter/flutter" */
  readonly repository?: string;
  /** Optional glob patterns (default: common source/docs) */
  readonly include?: readonly string[];
  /** Max matches to return (default: 50) */
  readonly limit?: number;
  /** Case-sensitive match (default: false) */
  readonly caseSensitive?: boolean;
  /** Also match filenames (default: true) */
  readonly searchFilenames?: boolean;
  /** Also match file contents (default: true) */
  readonly searchContents?: boolean;
}

export interface SearchMatch {
  readonly repository: string;
  readonly file: string;
  readonly absolutePath: string;
  readonly line: number | null;
  readonly snippet: string;
  readonly matchType: 'filename' | 'content';
}

export interface SearchResponse {
  readonly query: string;
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly matches: readonly SearchMatch[];
}

export interface SearchEngine {
  search(query: SearchQuery): Promise<SearchResponse>;
}

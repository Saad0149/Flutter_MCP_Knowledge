# Flutter Analysis Engine (MCP)

Local-first [Model Context Protocol](https://modelcontextprotocol.io) interface over a reusable **Flutter Analysis Engine**. The MCP server is one front end; the product is deterministic static analysis (facts → findings → insight) grounded in official Flutter/Dart knowledge cloned via git. No GitHub API and no LLM inside the server.

## Status

| Capability | Phase |
| --- | --- |
| MCP over stdio | 1 |
| Clone / pull official repos via git | 1 |
| Filesystem search | 1 |
| SQLite incremental index (TS heuristics) | 2 |
| `reindex` + index-aware `find_widget` / `search_source` | 2 |
| Dart `package:analyzer` helper (optional) | 3 |
| Knowledge tools + `review_project` | 3 |
| Engine + Dart site; CHANGELOG/migration kinds; widget tests; `find_intended_behavior` | 4 |
| Analysis engines + `analyze_*` tools | 4.1 |
| Insight narratives, health scores, confidence propagation, Dart-first AST | 0.5 / Part 1 |
| Evidence explorer, transparent scoring, debt, richer explain/intended behaviour | 0.6 |
| Analysis sessions: slim MCP payloads, cache-once / query-many | **0.7** |

## Supported repositories

**Current (Phase 4):**

- `flutter/flutter` — framework source
- `flutter/packages` — official packages
- `flutter/engine` — engine source
- `dart-lang/sdk` — Dart SDK
- `dart-lang/site-www` — Dart language site
- `flutter/samples` — official samples
- `flutter/website` — official documentation

Also indexed as first-class knowledge: **CHANGELOGs**, **migration guides**, and **widget tests**.

Git is only used to clone/pull these official trees. There is no GitHub API in normal operation.

## Requirements

- Node.js 20+
- `git` on `PATH`
- **Recommended:** Dart SDK 3+ (full-fidelity AST via `parser/`; without it, analysis falls back to heuristics with reduced confidence)

## Setup

```bash
cd flutter-knowledge-mcp
npm install
npm run build
```

Optional Dart helper (strongly recommended for project analysis):

```bash
cd parser && dart pub get && cd ..
```

Configuration (`config.json`):

```json
{
  "repositoriesRoot": "./repos",
  "indexPath": "./data/knowledge.sqlite",
  "indexOnUpdate": true
}
```

Paths resolve relative to the config file. Override with:

```bash
export FLUTTER_KNOWLEDGE_CONFIG=/absolute/path/to/config.json
```

## Cursor integration

```json
{
  "mcpServers": {
    "flutter-knowledge": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/flutter-knowledge-mcp/dist/index.js"]
    }
  }
}
```

## MCP tools

### Repository

| Tool | Description |
| --- | --- |
| `update_repositories` | Clone/pull all repos; reindexes when `indexOnUpdate` is true |
| `repository_status` | Existence, branch, commit, last pull, path |
| `reindex` | Build/refresh SQLite index (`force` optional) |

### Search & widgets

| Tool | Description |
| --- | --- |
| `search_source` | Index-aware symbol search with filesystem fallback |
| `find_widget` | Locate widget (index preferred) |
| `explain_widget` | Declaration, inheritance, docs from index |
| `trace_widget` | Inheritance tree + related symbols |

### Docs, examples & intended behavior

| Tool | Description |
| --- | --- |
| `search_docs` | Search indexed docs; optional `docKind` (`changelog` / `migration` / `guide` / `cookbook` / `general`) |
| `find_examples` | Samples / example directories |
| `find_tests` | Tests for a symbol; prefers widget tests |
| `find_best_practice` | Ranked migration / cookbook / changelog / guide hits |
| `find_intended_behavior` | Joins widget tests + samples + migrations/docs + source |

### Project analysis (insight-first, session-aware)

| Tool | Purpose |
| --- | --- |
| `review_project` | Analyze once → executive summary + `sessionId` (use `detail=full` only if needed) |
| `analyze_architecture` | Architecture slice from `sessionId` (or path) |
| `analyze_code_quality` | Maintainability slice from `sessionId` (or path) |
| `analyze_state_management` | State-flow slice from `sessionId` (or path) |
| `explain_finding` | Mentor-style explanation for **one** finding |
| `explore_finding` | Evidence for **one** finding (files, symbols, refactor) |

**Token-efficient workflow:**

1. `review_project({ path })` → health, top risks/strengths/actions, `sessionId`
2. `analyze_architecture({ sessionId })` / `analyze_*` → slim category views (no rescan)
3. `explore_finding({ sessionId, findingCode })` / `explain_finding` → drill into one issue

Full reports are stored under `data/analysis-sessions/`. Follow-up tools read the cache.

### Confidence model

Every finding includes `confidence` (0–1) and `source` (`dart_analyzer` | `heuristic` | `filesystem` | `pubspec` | `import_graph`).

`review_project` leads with an **Analysis Summary**:

- Engine identity (`Flutter Analysis Engine v0.7.0`)
- AST source (`dart_analyzer` or `heuristic`)
- Coverage (`full` / `partial` / `none`)
- Aggregate confidence
- Recommendation to install Dart SDK when falling back

Each category score includes **positive/negative contributors**, weight, and confidence. Findings carry structured `evidenceItems`, related finding codes, and knowledge-resolved official references when the index has matches.

Official references stay as **supporting evidence**, not the primary answer. Insight narratives and explained health scores are the main deliverable.

Engines live under `src/analysis/` (ast / engines / insight / metrics / rules / session) and are reusable outside MCP. Handlers orchestrate analyze → cache → slim query.

Typical first-run flow:

1. `update_repositories` (large first clone — includes engine)
2. Wait for index (or call `reindex`)
3. `review_project` → then session-scoped `analyze_*` / `explore_finding` / `find_intended_behavior`

## Architecture

```text
Cursor
  └── MCP (stdio) — thin tools/
        └── analysis/  (future flutter-analysis-core)
              ├── ast/          AstAdapter (Dart preferred, heuristic fallback)
              ├── engines/      CodeQuality / State / Architecture
              ├── insight/      Explanation + Recommendation + Health + ReportBuilder
              ├── session/      AnalysisSessionStore + slim summary views
              ├── metrics/      MetricsEngine
              ├── rules/        RuleEngine plugin registry
              ├── project-scanner.ts
              └── official-refs.ts
        ├── repository/     git clone / pull / status
        ├── indexer/        incremental hashing + path classification
        ├── parser/         TS heuristics + Dart analyzer client
        ├── store/          SQLite knowledge store (schema v2)
        ├── search/         IndexedSearchEngine → filesystem fallback
        ├── config/         JSON + zod
        └── server/         DI (tsyringe) + McpServer
```

## Development

```bash
npm run test
npm run typecheck
npm run lint
npm run dev
```

## Error model

Tools return structured JSON failures (never raw exceptions), including:

`RepositoryNotFound`, `RepositoryMissing`, `GitError`, `SearchFailed`, `InvalidArguments`, `ConfigError`, `IndexError`, `AnalyzerUnavailable`, `ProjectNotFound`, `InternalError`.

## Logging

Structured JSON on **stderr** (`info` / `warning` / `error`). stdout is MCP-only.

## Roadmap (later)

- Monorepo extract (`packages/flutter-analysis-core`, CLI, web)
- Additional analyzers (dependency, complexity, performance, accessibility, testing, docs)
- Retire heuristic AST fallback when Dart Analyzer coverage is always available
- Vector embeddings / semantic search
- Optional third-party ecosystems (e.g. FlutterFire)

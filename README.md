# Flutter Analysis Engine (MCP)

An [MCP](https://modelcontextprotocol.io) server that gives your AI coding agent (Cursor, Claude Code, or any other MCP client) deep, structured knowledge of Flutter/Dart. It does two things: runs 9 static analyzers over your own project (architecture, code quality, performance, accessibility, and more — facts and scored findings, not vibes) and answers "how is X actually meant to be used?" by searching official Flutter/Dart source, tests, samples, and docs cloned locally via git. There's no LLM inside the server and no GitHub API — everything is deterministic analysis grounded in real source.

## What it checks — all 9 analyzers

| Analyzer | Checks |
| --- | --- |
| **Code quality** | God-class candidates (multi-signal, not just size), missing `const`, legacy `RaisedButton`/`FlatButton`, `print()` calls, modern Dart class modifiers, pattern matching usage |
| **Architecture** | Detected architecture style (clean/feature-first/layered/MVVM/...), layer-violation imports (presentation→data, domain→Flutter), circular import cycles, feature isolation |
| **State management** | Which state approach(es) are in use, heavy `setState`, missing `dispose()`, `ChangeNotifier` without a `Provider`, business logic living in widgets |
| **Complexity** | File-size distribution, estimated high-complexity files, deep nesting, high import counts, oversized widget files |
| **Dependencies** | Layer violations, circular import cycles, high-fan-out files, deprecated packages, whether dependency versions are pinned |
| **Performance** | Oversized `build()` methods, legacy `new` keyword usage, `setState` wrapping async/heavy work, `AnimationController` leaks, `ListView` misuse, `Image.network` without cache hints |
| **Documentation** | Widget/class doc-comment coverage, README/CHANGELOG/`analysis_options.yaml` presence, pubspec description, inline comment ratio |
| **Testing** | Test-to-lib ratio, widget/golden/integration test presence, features with no tests at all |
| **Accessibility** | `Semantics` widget usage, images without semantic labels, `IconButton`s without tooltips, `CustomPainter` accessibility |

Every finding carries a `confidence` score and a `source` (`dart_analyzer` | `heuristic` | `filesystem` | `pubspec` | `import_graph`) — see [Known limitations](#known-limitations) for what that means in practice.

## Install

### Quick try (npx, no local checkout)

**Cursor** — add to `mcp.json`:

```json
{
  "mcpServers": {
    "flutter-knowledge": {
      "command": "npx",
      "args": ["-y", "flutter-knowledge-mcp"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add flutter-knowledge -- npx -y flutter-knowledge-mcp
```

This is the fastest way to try it. For real use, read the note below first — it affects where the (multi-GB) Flutter/Dart knowledge base gets stored.

### Recommended for real use: a stable config location

By default this server looks for `config.json` next to its own install location and clones the knowledge-base repos relative to that. Under a bare `npx` invocation that location isn't guaranteed to persist between runs (npx's cache can be cleared), which means repos you already cloned could vanish. Point it at a stable, user-owned directory instead:

```bash
mkdir -p ~/.flutter-knowledge-mcp
cat > ~/.flutter-knowledge-mcp/config.json <<'EOF'
{
  "repositoriesRoot": "~/.flutter-knowledge-mcp/repos",
  "indexPath": "~/.flutter-knowledge-mcp/data/knowledge.sqlite",
  "indexOnUpdate": true
}
EOF
```

Then set `FLUTTER_KNOWLEDGE_CONFIG` in your MCP client config, e.g. for Cursor:

```json
{
  "mcpServers": {
    "flutter-knowledge": {
      "command": "npx",
      "args": ["-y", "flutter-knowledge-mcp"],
      "env": {
        "FLUTTER_KNOWLEDGE_CONFIG": "/Users/you/.flutter-knowledge-mcp/config.json"
      }
    }
  }
}
```

(`~` isn't expanded inside `config.json` values or MCP client env blocks — use an absolute path.) `dartSdkPath` is an optional additional key in the same file — see [Dart detection](#dart-not-found-analysis-running-in-heuristic-mode) below.

### From source (contributing, or before this package is published)

```bash
git clone https://github.com/Saad0149/Flutter_MCP_Knowledge.git
cd Flutter_MCP_Knowledge
npm install
npm run build
```

Optional Dart helper (strongly recommended — see [Known limitations](#known-limitations)):

```bash
cd parser && dart pub get && cd ..
```

Then point your MCP client at the built entry point directly:

```json
{
  "mcpServers": {
    "flutter-knowledge": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/Flutter_MCP_Knowledge/dist/index.js"]
    }
  }
}
```

### Requirements

- Node.js 20+
- `git` on `PATH` (used only to clone/pull the official Flutter/Dart repos below — no GitHub API)
- **Recommended:** Dart SDK 3+ (full-fidelity AST via `parser/`; without it, project analysis falls back to heuristics with reduced confidence — see [Known limitations](#known-limitations))

## Knowledge base

On first use, `flutter/flutter`, `flutter/packages`, `flutter/engine`, `dart-lang/sdk`, `dart-lang/site-www`, `flutter/samples`, and `flutter/website` are shallow-cloned locally and indexed (CHANGELOGs, migration guides, and widget tests included). This is several GB — see the stable-config note above.

## Tools

### Diagnostics — start here

| Tool | What it does |
| --- | --- |
| `check_environment` | One-call self-diagnostic: is Dart found (and how), what's the Node version, did the SQLite native binding load, are the knowledge-base repos ready. Call this any time something "should just work" doesn't. |

### Repository management

| Tool | What it does |
| --- | --- |
| `update_repositories` | Starts background clones/pulls for all official repos; returns immediately with per-repo status |
| `repository_status` | Existence, branch, commit, last pull time, path — per repo |
| `reindex` | Builds/refreshes the local SQLite index from cloned repos |

### Search & widget knowledge

| Tool | What it does |
| --- | --- |
| `search_source` | Search filenames/contents across cloned official repos |
| `find_widget` | Locate a widget by name (index-first, filesystem fallback) |
| `explain_widget` | Declaration, inheritance, and docs for a widget from the index |
| `trace_widget` | Inheritance tree and related symbols |
| `search_docs` | Search indexed docs, optionally filtered by kind (changelog/migration/guide/cookbook) |
| `find_examples` | Examples from official samples and `example/` directories |
| `find_tests` | Tests for a symbol, widget tests preferred |
| `find_best_practice` | Ranked migration/cookbook/changelog/guide hits for a topic |
| `find_intended_behavior` | Joins widget tests + samples + migrations/docs + source for "how is this meant to be used?" |

**First-use note:** if the knowledge base hasn't been cloned yet, `find_intended_behavior` (and the other knowledge tools above) auto-trigger a background clone and return `{ status: "building", suggestedAction }` immediately instead of blocking for minutes or silently returning nothing. This is expected the first time you use them — retry shortly, or call `repository_status` to watch progress. Once the index is partially built, they serve what's available and note which sources are still missing.

### Project analysis (session-aware)

| Tool | What it does |
| --- | --- |
| `review_project` | Analyze your project once → executive health summary + `sessionId` |
| `analyze_code_quality` / `analyze_architecture` / `analyze_state_management` / `analyze_complexity` / `analyze_dependencies` / `analyze_performance` / `analyze_documentation` / `analyze_testing` / `analyze_accessibility` | One slim, scored view per analyzer, from a `sessionId` (no rescan) or a fresh `path` |
| `explain_finding` | Mentor-style explanation for one finding |
| `explore_finding` | Full evidence for one finding (files, symbols, refactor suggestions) |

Typical flow: `review_project({ path })` → grab `sessionId` → `analyze_*({ sessionId })` for the categories you care about → `explore_finding({ sessionId, findingCode })` to drill into a specific one. Session reports are cached under `data/analysis-sessions/`, so steps after the first don't rescan.

## Known limitations

- **Heuristic-fallback mode.** Full-fidelity analysis needs the Dart SDK (`dart run package:analyzer` under the hood). Without it, symbol extraction falls back to regex-based heuristics with reduced confidence — findings still show a `confidence`/`source` field so you can tell which mode produced them, and `review_project` surfaces a `fidelityNotice` when this is happening. Call `check_environment` any time to see exactly why (Dart not found vs. found-but-helper-failing) and how to fix it.
- **Evidence may contain untrusted content.** This server is designed to scan arbitrary third-party Flutter/Dart projects. `evidence`/`snippet` fields in tool responses are raw excerpts from whatever the scanned project (or an indexed repo) actually contains — structurally separate from this server's own narrative fields, but not vetted or sanitized content. See [`SECURITY_DECISIONS.md`](./SECURITY_DECISIONS.md) (§2) for why this is a deliberate tradeoff, not an oversight.
- **`officialReference` matching is coarse.** Findings link to official docs/source via keyword search (SQL substring matching against indexed doc chunks and titles), not semantic matching — occasionally a reference will be tangentially related rather than exactly on point. Treat it as supporting evidence, not the primary answer.
- **Local-only knowledge, git-cloned.** No GitHub API, no network calls beyond `git clone`/`git pull` against the repos listed above. If those repos are unreachable, the affected knowledge tools degrade gracefully (see the auto-bootstrap note above) rather than failing outright.

## Architecture

```text
MCP client (Cursor, Claude Code, ...)
  └── MCP (stdio) — thin tools/
        └── analysis/
              ├── ast/          AstAdapter (Dart analyzer preferred, heuristic fallback)
              ├── engines/      the 9 analyzers listed above
              ├── insight/      explanation + recommendation + health scoring + report builder
              ├── session/      AnalysisSessionStore + slim summary views
              ├── metrics/      MetricsEngine
              ├── rules/        RuleEngine plugin registry
              ├── project-scanner.ts
              └── official-refs.ts
        ├── repository/     git clone / pull / status
        ├── indexer/        incremental hashing + path classification
        ├── parser/         TS heuristics + Dart analyzer client
        ├── store/          SQLite knowledge store
        ├── search/         indexed search → filesystem fallback
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

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for what to include in a bug report or PR.

## Error model

Tools return structured JSON failures (never raw exceptions): `RepositoryNotFound`, `RepositoryMissing`, `GitError`, `SearchFailed`, `InvalidArguments`, `ConfigError`, `IndexError`, `AnalyzerUnavailable`, `ProjectNotFound`, `NativeBindingError`, `InternalError`.

## Logging

Structured JSON on **stderr** (`info` / `warning` / `error`). stdout is MCP-protocol-only.

## Troubleshooting

Run `check_environment` first — it's a single tool call that reports pass/fail for the two things known to silently degrade this server, plus repo readiness. No need to read logs or guess from an unexplained confidence percentage.

It reports:

- **Dart**: whether it was found, via which method (`config_override` / `known_location` / `path_lookup` / `not_found`), and the resolved path
- **Node**: the exact Node version, platform, and arch this server process is running under
- **SQLite**: whether the `better-sqlite3` native binding loaded and is responding to a live query
- **Repositories**: how many of the knowledge-base repos are cloned, and which (if any) are missing

### Dart not found (analysis running in heuristic mode)

`review_project` will show `astSource: "heuristic"` and a prominent `fidelityNotice`. `check_environment` will show `dart.found: false` (or `found: true` with `versionCheckPassed: false`, meaning a binary exists at that path but couldn't run — usually a permissions or architecture mismatch).

This server does **not** rely solely on inherited PATH — it checks, in order: an explicit `dartSdkPath` in `config.json`, then common install locations (`/usr/local/bin/dart`, `/opt/homebrew/bin/dart`, `~/Documents/flutter/bin/dart`, `~/flutter/bin/dart`, `~/fvm/versions/*/bin/dart`, Windows equivalents), then PATH. If none of those find it:

1. Confirm Dart actually works in a normal terminal: `dart --version`.
2. Find its real path: `which dart` (macOS/Linux) or `where dart` (Windows).
3. Set that exact path as `dartSdkPath` in `config.json` and restart the server — this bypasses PATH entirely, which matters because MCP clients (Cursor, Claude Code, etc.) don't reliably forward a shell-equivalent PATH to spawned servers, and even explicit `PATH=` entries in a client's env config are often passed through literally (no `~` or `$PATH` expansion), so a config value like `PATH=~/flutter/bin:$PATH` silently resolves to nothing useful.

### SQLite native binding failed

`check_environment` will show `sqlite.ok: false` with the underlying error. This almost always means `better-sqlite3`'s native binary doesn't match the Node version/OS/architecture actually running the server (e.g. installed under one Node version, run under another; or copied between machines).

Fix: run `npm rebuild better-sqlite3` (or delete `node_modules` and `npm install` again) in the server's directory, then restart it.

The server checks for this at startup, before opening the database, and again before touching it — if it fails, the server still starts (so `check_environment` and every other tool that doesn't need the local index keep working) rather than refusing to start with no explanation. Tools that do need the index (search/find/analyze tools) will fail with this same clear error until it's fixed.

#### The server crashed / disconnected on startup with no error message at all

This is the more severe version of the same problem: a native module ABI mismatch can, in rare cases, crash the whole Node process before any of the handling above gets a chance to run at all — no structured error, no log line, the MCP client just shows the server as disconnected. If you hit this:

1. It's still almost certainly the same `better-sqlite3` native-binding mismatch described above (this is the one native dependency in this server that can fail this way) — run `npm rebuild better-sqlite3` in the server's directory and restart. This fixes the vast majority of cases, including this one.
2. If it keeps happening: check the server's stderr/logs directly (where this server's structured JSON logs go — see [Logging](#logging)) for a `NativeBindingError` line logged right before the crash; it'll usually still get written even in a hard-crash scenario, since logging happens before the risky database open.
3. As a last resort, delete `node_modules` entirely and run `npm install` fresh — this guarantees the native binary was actually built/fetched for the Node version currently running, rather than trusting an existing (possibly stale) `node_modules`.

Why this can't be fully prevented from JS: normal error handling (try/catch) only works for failures the JS engine gets a chance to observe. A genuine native ABI mismatch can crash at the OS/process level before that happens. This server narrows that risk as much as is realistically possible — it checks that a native binary actually exists for the current platform/architecture *before* ever attempting to load it, and wraps every load/open attempt it does make in error handling with a clear message — but it can't give an absolute guarantee against every possible native-code failure. What it does guarantee: the common cases (wrong Node version, wrong OS, wrong architecture, missing prebuilt binary) are caught and explained, not silently crashed.

### Repositories missing

`check_environment` lists them by name under `repositories.missing`. Call `update_repositories`, poll `repository_status` until `cloneInProgress` is false, then `reindex`.

## Security

This server scans arbitrary, potentially-untrusted third-party Flutter/Dart projects by design — see [`SECURITY_DECISIONS.md`](./SECURITY_DECISIONS.md) for the specific tradeoffs that implies and why they're intentional. To report a vulnerability, see [`SECURITY.md`](./SECURITY.md) — please don't file it as a public issue.

For non-security bugs, see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Roadmap (later)

- Monorepo extract (`packages/flutter-analysis-core`, CLI, web)
- Retire heuristic AST fallback when Dart Analyzer coverage is always available
- Vector embeddings / semantic search
- Optional third-party ecosystems (e.g. FlutterFire)

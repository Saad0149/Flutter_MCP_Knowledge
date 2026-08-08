# Security Audit Findings — Flutter Analysis Engine MCP

Audit date: 2026-08-07. Scope: full `src/` tree + `parser/bin/extract_symbols.dart` entry
point. Methodology: manual code review of every subprocess call, SQL query, path-construction
site, and tool input schema, cross-referenced against `git log`/`git status`, plus **empirical
timing tests** for the two categories (ReDoS, resource exhaustion) where "looks risky" and "is
actually exploitable" can diverge — findings below are backed by reproduced evidence, not
pattern-matching alone. Analyzers, Rule Engine, Evidence Engine, and the session-caching layer
were read for this audit but not modified, per scope.

Severity scale: **Critical** (unauthenticated remote-equivalent DoS or arbitrary file
read/write reachable from a single tool call) / **High** (real but narrower/harder to trigger)
/ **Low** (defense-in-depth, no realistic exploit path found) / **None** (checked, not found).

---

## 1. Command / argument injection

**Status: checked, not found.**

- Every subprocess call uses `child_process.spawn(cmd, argsArray, ...)` — no `shell: true`
  anywhere in the codebase (`grep -rn "shell:\s*true"` → 0 hits), no `exec`/`execSync` usage at
  all. `src/parser/dart-analyzer-client.ts:166,320` — array-based `spawn`, safe against shell
  metacharacter injection regardless of what's in `execPath`/args.
- Git operations go through `simple-git` (`src/repository/repository-manager.ts:243,255`),
  which itself spawns `git` with an argument array, not a shell string.
- The only tool-facing parameter that reaches a subprocess-adjacent path is `repository` (e.g.
  `find_widget`, `search_source`, `reindex`). It is resolved via
  `RepositoryManager.resolveDefinition(name)`, which matches only against the hardcoded
  `SUPPORTED_REPOSITORIES` list (`src/repository/definitions.ts`) and throws on anything else —
  no attacker-controlled string ever reaches `cloneUrl` or a spawned command.
- `dartSdkPath` (config-only, not a tool argument) is existence-checked
  (`src/parser/dart-sdk-locator.ts:134`) before being passed as `execPath` to `spawn` — even if
  it contained spaces/special characters, `spawn` with an args array never shell-interprets it.

## 2. Path traversal / arbitrary file access

**Status: PRESENT — Critical.**

`AnalysisSessionStore.get(sessionId)` (`src/analysis/session/analysis-session-store.ts:66-76`)
builds a file path with **zero validation** of `sessionId`:

```ts
const file = path.join(this.sessionsDir(), `${sessionId}.json`);
```

`sessionId` is a tool-facing, optional parameter on **12 tools** (`analyze_code_quality`,
`analyze_architecture`, `analyze_state_management`, `analyze_complexity`,
`analyze_documentation`, `analyze_testing`, `analyze_dependencies`, `analyze_performance`,
`analyze_accessibility`, `explain_finding`, `explore_finding`, and indirectly `review_project`'s
callers) — every one of them accepts `sessionId: z.string().min(1).optional()` with no format
constraint, and routes it straight into `AnalysisSessionStore.resolve()` → `get()`.

Proof of concept (verified, not hypothetical):

```sessionId = "../../../../../../tmp/poc-secret"
→ path.join(sessionsDir, "../../../../../../tmp/poc-secret.json")
→ resolves to /tmp/poc-secret.json — fully escapes data/analysis-sessions/
```

Legitimate session IDs are always server-generated
(`randomUUID().replace(/-/g, '').slice(0, 16)` — 16 lowercase hex chars,
`analysis-session-store.ts:41`), so any `sessionId` containing `/`, `..`, or non-hex characters
is definitionally invalid input, never a legitimate use case. Any readable `.json` file on the
host reachable via relative traversal from `data/analysis-sessions/` can be read this way; the
content is `JSON.parse`'d and cast (not runtime-validated) to `StoredAnalysisSession`, so
practical exfiltration depth depends on whether downstream field access on the mismatched shape
throws (caught) — but the file read itself succeeds regardless, which is the traversal bug.
Fixing this removes no capability: no legitimate caller ever needed a non-hex sessionId.

Everything else checked in this category is safe:

- `RepositoryManager.getRepositoryPath(name)` — `name` constrained to the fixed
  `SUPPORTED_REPOSITORIES` list via `resolveDefinition`, throws on unknown names.
- `ReindexHandler` → `RepositoryIndexer.indexRepository(name)` — same `resolveDefinition` guard.
- `config.indexPath` / `config.repositoriesRoot` / `dartSdkPath` — server-config only, never
  tool-facing.
- The user-supplied **target project path** (`path` argument to `review_project`/`analyze_*`)
  is intentionally unrestricted by design — see `SECURITY_DECISIONS.md` item 1. This is a
  different question from the internal-directory escape above.

## 3. Symlink handling

**Status: PRESENT — High.**

`ProjectScanner.scan()` (`src/analysis/project-scanner.ts:70-75`) walks the **arbitrary,
potentially-untrusted target project** with:

```ts
const dartPaths = await fg(['**/*.dart'], { cwd: projectPath, absolute: false, onlyFiles: true, ignore: [...IGNORE] });
```

No `followSymbolicLinks: false`, and every matched path is `readFile`'d and its full content
placed into `dartFiles[].content`, which flows into every analyzer's regex scans and, via
finding evidence, back into MCP tool responses. A symlink inside the scanned project — e.g.
`lib/x.dart -> /Users/victim/.ssh/id_rsa` (file) or `lib/shared -> /Users/victim/Documents`
(directory) — is followed by default, so its target's content (or, for a directory symlink,
every `.dart`-named file recursively under the target) is read and can be echoed back through
search/evidence snippets, entirely outside the project the caller pointed at.

This is distinct from the "target path is open" design decision (Phase-3 item 1): that's about
the top-level path being unrestricted; this is about symlinks *inside* that tree silently
redirecting the scan elsewhere on the host.

**Notably, this exact protection already exists elsewhere in the codebase and was simply never
applied here**:

- `src/search/filesystem-search.ts:77` — `followSymbolicLinks: false` (walks the server's own
  cloned official repos).
- `src/indexer/repository-indexer.ts:152` — `followSymbolicLinks: false` (same).

`ProjectScanner` is the one surface that walks arbitrary third-party projects — the
higher-risk surface — and is the one place missing the guard the codebase already knows to use.

## 4. SQL injection

**Status: checked, not found.**

Every query in `src/store/sqlite-store.ts` uses `db.prepare(...).run/get/all(...params)` with
`?` placeholders — `findSymbols`/`findDocs` build the `WHERE` clause dynamically but only ever
push **parameter placeholders** for user-controlled values (`nameContains`, `query`,
`repositoryName`, `docKind`, `docKinds`); the `%...%` LIKE-wildcard wrapping happens in JS
*before* binding, not via string concatenation into SQL text. No query in the codebase
concatenates a user-controlled value directly into a SQL string.

The only string-interpolated SQL is in `ensureColumn()`
(`PRAGMA table_info(${table})` / `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`,
`sqlite-store.ts:552-559`) — required because SQLite has no parameter-binding for DDL
identifiers in any dialect. Both call sites pass hardcoded literals only
(`'symbols'`/`'is_widget_test'`/`'INTEGER NOT NULL DEFAULT 0'`, `'docs'`/`'doc_kind'`/...) —
never reachable from any tool input. Noted for completeness, not exploitable today.

## 5. Regex denial of service (ReDoS)

**Status: PRESENT — Critical (in the pathGlob→regex translator, not the heuristic parser).**

The prompt's specific worry — the heuristic Dart extractor's regexes
(`src/parser/heuristic-extractor.ts`) — was empirically tested, not just eyeballed:

```FUNCTION_RE / TYPEDEF_RE against adversarial 80KB adversarial non-matching lines: 0.06–0.90ms, linear scaling.
```

Both have a repeated character class that includes `\s` immediately followed by `\s+`
(theoretically ReDoS-shaped), but neither has the *nested* quantifier structure
(`(a+)+`-style) required for actual catastrophic backtracking, and V8's engine handles the
single-level adjacency fine in practice — confirmed up to 80,000-char lines. **No fix needed
here; flagging a "looks risky" pattern as a real vulnerability without testing it would have
been a false positive.**

The real ReDoS is elsewhere: **`globToRegExp()`** in `src/tools/tool-response-helpers.ts:69-92`,
used by every `analyze_*` tool's `pathGlob` scoping parameter (shared via `ScopeFilterSchema`,
9 tools). It translates each `**` in the glob to `.*` in the compiled regex with no collapsing
of consecutive `**` segments — chaining `N` copies of `**` produces `N` adjacent `.*` groups,
the textbook catastrophic-backtracking shape. Verified:

```pathGlob = ("**/" × n) + "nomatch", tested against a 40-segment non-matching path:
n=3:  0.26ms
n=5:  16ms
n=8:  1887ms
n=10: still running after 20s (killed)
```

A ~50-character `pathGlob` value hangs the single-threaded Node process indefinitely — this
blocks the *entire* MCP server, not just the one request, for every connected client. Trivially
reachable from any of the 9 `analyze_*` tools with no auth/rate-limit in front of it. This is
the single most severe finding in this audit.

## 6. Resource exhaustion / DoS

**Status: PRESENT — Low/Medium (several sub-items; the critical DoS is #5, cross-referenced
here since it's also a resource-exhaustion bug).**

- **`pathGlob` ReDoS** — see #5. Also a resource-exhaustion bug by definition (unbounded CPU
  from bounded-looking input).
- **No per-file size cap** in `ProjectScanner.scan()` — `readFile(absolutePath, 'utf8')`
  (`project-scanner.ts:82`) loads each matched file fully into memory with no ceiling. A
  pathological/adversarial single file (or many) in a scanned project can drive memory use
  arbitrarily high; every analyzer then also regex-scans that content, multiplying CPU cost.
- **No cap on matched file count** — `fg(['**/*.dart'], {...})` returns an unbounded list;
  combined with #3 (symlinked directories), this is the mechanism by which a directory-escape
  turns into a volume-based DoS (scanning millions of files reachable via one symlink).
- **Unbounded recursion in cycle detection** — `detectCycles()`'s `dfs()`
  (`src/analysis/engines/dependency-analyzer.ts:286-302`) is genuine JS call-stack recursion
  with no depth limit. A long linear import chain (plausible in a large real monorepo, not just
  adversarial) can exceed Node's stack size and throw `RangeError: Maximum call stack size
  exceeded`. This *is* caught by the surrounding tool `try/catch` (so it degrades to a
  `toolFail` response rather than crashing the process), but it's still a needless single-request
  failure mode with a clean iterative fix available.
- **Git clone size**: not attacker-influenced — clone targets are the fixed
  `SUPPORTED_REPOSITORIES` list (official Flutter/Dart repos only), no user-supplied clone URL
  exists anywhere in the tool surface.
- **Findings/response payload size**: already bounded — `ProjectReportBuilder.build()` slices
  `report.findings` to the `limit` parameter (zod-capped at 200/300 depending on tool) before
  any tool response is built (`project-report-builder.ts:159`). `explain_finding`/
  `explore_finding` already cap evidence arrays via `capEvidence`/`maxEvidence` (max 200).

## 7. Prototype pollution / unsafe JSON handling

**Status: checked, not found.**

Three `JSON.parse` call sites on file content:
`repository-manager.ts:323` (server-written clone metadata), `analysis-session-store.ts:72,119`
(server-written session cache), `config/load-config.ts:28` (operator's config.json),
`dart-analyzer-client.ts:231` (Dart helper subprocess stdout, JSON-marker-delimited).

None of the parsed results are ever merged into a mutable object via `Object.assign` or spread
(`grep` for `Object.assign(` / `...` -spreading a parse result → 0 hits), and none are used to
build dynamic property keys from external data (`grep` for `[x.name] =` / `[x.title] =`
patterns → 0 hits). `config/load-config.ts` additionally validates through
`ConfigSchema.safeParse()` (zod, strip-unknown-keys by default, no `.passthrough()`) and then
reconstructs the config object field-by-field from named properties
(`{repositoriesRoot: ..., indexPath: ...}`), never spreading the parsed value — even a raw
`"__proto__"` key in `config.json` would simply be dropped by zod's strip behavior, never
reaching an assignment. No merge-into-mutable-object pattern exists anywhere in the codebase, so
there's no reachable prototype-pollution sink today.

## 8. TOCTOU / race conditions

**Status: PRESENT — Low (mostly closed; one latent gap).**

- **The known transient-vs-singleton `RepositoryManager` bug is confirmed fixed** —
  `src/server/container.ts:135` registers it via `registerSingleton`, so the `inProgressSet`
  used by `startBackgroundUpdate()`'s check-then-act (`repository-manager.ts:122-131`) is
  correctly shared across all resolutions. Since the decision loop inside
  `startBackgroundUpdate()` runs synchronously with no `await` before every repo's state is
  decided, concurrent calls to it cannot interleave (single-threaded JS, no yield point) — this
  class of race is closed for that entry point.
- **Latent gap**: `RepositoryManager.updateOne(name)` (`repository-manager.ts:108-111`) calls
  `updateRepository()` directly, **bypassing `inProgressSet` entirely** — it has no
  check-then-act guard against a concurrent `startBackgroundUpdate()` (or another `updateOne`)
  targeting the same repo. Currently unreachable from any tool (`grep` confirms no caller
  outside its own definition), so not exploitable today, but it's a public method on the
  `RepositoryManager` interface and a live regression risk if ever wired to a tool — this is
  literally the same bug class already fixed once, just via a second, unguarded entry point.
- SQLite writes (`replaceSymbolsForFile`/`replaceDocsForFile`) are wrapped in
  `db.transaction()` — atomic, no race.
- `AnalysisSessionStore.save()` writes a fresh `randomUUID()`-named file per call (no filename
  collision possible) plus a `latest-<hash>.json` pointer keyed by project-path hash; concurrent
  saves for the same project can race on which one "wins" as latest, but each write is a
  complete, valid JSON file — last-write-wins is a UX nuance, not data corruption or a security
  issue.

## 9. Tool-output content handling (indirect prompt injection / tool poisoning)

**Status: PRESENT — Low (structural separation already exists; the missing piece is the
explicit warning).**

`EvidenceItem.detail`, `AnalysisFinding.evidence`, and the `snippet` fields returned by
`search_source`, `find_widget`, `search_docs`, `find_examples`, `find_tests`,
`find_best_practice`, `find_intended_behavior` are already **structurally** separate JSON
fields from narrative fields (`description`, `recommendedFix`, `title`, `summary`,
`whyItMatters`) — an agent parsing the response can already tell "this came from evidence" vs
"this is engine narrative" by field name alone. What's missing: **no schema/description text
anywhere states that evidence/snippet content is raw, untrusted material from the scanned
project** (`grep` for "untrusted"/"prompt injection"/"do not treat as instructions" → 0 hits
repo-wide). Since these tools routinely return literal substrings of arbitrary third-party
source files, a calling agent has no explicit signal to avoid treating unusual content inside a
snippet (e.g. text resembling instructions) as anything other than data.

## 10. Sensitive data in logs/errors

**Status: PRESENT — informational only; one item already correctly deferred to Phase 3.**

- `DartAnalyzerClient` logs the full `process.env.PATH` value at startup
  (`dart-analyzer-client.ts:93-94`) — this is the **already-known Phase-3 item** ("Diagnostic
  logging verbosity"), confirmed still present and still intentional (needed for debugging the
  exact PATH-forwarding bug class that took multiple rounds to fix). Not touched here — see
  `SECURITY_DECISIONS.md` item 4.
- Checked for anything *worse*: no full `process.env` dump anywhere (`grep` confirms `PATH` is
  the only env var ever logged), subprocess stdout/stderr in error messages is already truncated
  to 500 chars via `truncateForLog()` (`dart-analyzer-client.ts`), and no config file contents
  are ever logged wholesale.
- `toStructuredError()`'s fallback branch for non-`Error`, non-`AppError` thrown values
  (`utils/errors.ts:76-80`) echoes the raw thrown value into `details` — a rare path (only hit
  by `throw <non-Error>`, not normal application flow) and low-impact, but worth a defensive
  note. Not fixed (would be speculative hardening against a pattern that doesn't occur anywhere
  in the current codebase — every throw site uses `AppError`).
- Absolute host paths in error messages (e.g. `Project path does not exist: /Users/...`) are
  expected/useful for a local stdio tool and not flagged as a fix item — this is normal
  debugging information for a tool that only ever talks to the same local user who invoked it.

## 11. Supply chain

**Status: PRESENT — Low (mostly good hygiene already; two gaps).**

- `npm audit --json`: **0 vulnerabilities** across 324 dependencies (prod 122 / dev 203 /
  optional 53). Verified by running it, not assumed.
- `package-lock.json` is committed (156KB, real lockfile, not a stub).
- `package.json` already scopes install-script execution via `allowScripts` to just
  `better-sqlite3` (good existing hardening — most packages can't run arbitrary postinstall
  scripts).
- **Gap 1**: all dependencies use caret ranges (`^13.0.2`, `^3.36.0`, ...) including
  `better-sqlite3` (ships a native binary) and `simple-git` (spawns subprocesses) — the two
  highest-risk-if-compromised packages. The committed lockfile mitigates this for `npm ci`
  installs, but a plain `npm install` after any dependency bump can still drift within the
  caret range. Worth pinning these two exactly.
- **Gap 2**: no `SECURITY.md` — no documented vulnerability-disclosure process for a
  public-release project.

## 12. Input validation / type confusion at the tool boundary

**Status: PRESENT — Low/Medium (systemic, but low severity per-instance; one instance already
covered as Critical under #2/#5).**

Every tool handler does call `Schema.safeParse(input)` before use — **type confusion itself is
already well-guarded** (zod rejects wrong types outright). The gap is narrower: **no free-text
string input anywhere in the tool surface has a `.max()` length bound.** Confirmed via
`grep -n "z\.string()\.min(1)" src/tools/*.ts` returning 30+ matches, none paired with `.max(`:
`topic`, `query`, `name`, `symbol`, `path`, `sessionId`, `findingCode`, `pathGlob`, `feature`,
`repository`, `docKind` filters, etc. across every tool. Numeric params (`limit`, `depth`) are
consistently bounded (`.max(40)`/`.max(100)`/`.max(200)`/`.max(300)`/`.max(5)`), but strings are
not. A multi-megabyte `topic`/`query` string would reach `store.findDocs()`'s SQL `LIKE`
binding and general string processing unchecked — not a crash risk (SQLite handles large bound
parameters), but wasteful and inconsistent with the numeric-parameter discipline already
applied elsewhere. The two concretely dangerous instances of this general gap are already
called out with full severity under **#2** (`sessionId` — should be exactly 16 hex chars, not
just "a string") and **#5** (`pathGlob` — the ReDoS is only reachable because nothing bounds its
length or complexity).

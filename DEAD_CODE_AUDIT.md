# Dead Code & Bloat Audit — Flutter Analysis Engine MCP

Audit date: 2026-08-12. Scope: full `src/` tree (16,238 lines across 96 TS files), `package.json`
dependencies, and the tool-registration path (`src/tools/register-tools.ts`,
`src/server/container.ts`). Methodology: read `register-tools.ts` as the authoritative "what's
actually live" map, cross-referenced every candidate finding against `SECURITY_DECISIONS.md`,
`AUDIT_FINDINGS.md`, `DUPLICATE_FINDINGS_AUDIT.md`, and `CONFIDENCE_AUDIT.md` before including it
below; verified every "unused" claim by grepping across both `src/` and `tests/` (not `src/`
alone — a symbol only used by a test is not dead), and by reading the actual call sites, not
just counting hits.

**Nothing was changed in this pass.** Investigation and reporting only, per the task's Phase 1
scope. Every "safe to remove" item below is a recommendation, not an action taken.

---

## Summary

| Category | Count |
| --- | --- |
| SAFE TO REMOVE | 6 |
| NEEDS HUMAN DECISION | 5 |
| DO NOT TOUCH (investigated, correctly excluded) | 13 |

The three prior audit passes (`AUDIT_FINDINGS.md`'s security fixes, `DUPLICATE_FINDINGS_AUDIT.md`'s
5 finding-code merges, `CONFIDENCE_AUDIT.md`'s basis/confidence work) all show up in the current
code as **already applied** — I checked each one's "current state" before treating anything near
it as a fresh finding. This audit did not have to re-flag any of that work; the DO NOT TOUCH
section below documents what was checked and correctly left alone, including that prior work.

---

## SAFE TO REMOVE

Genuinely dead, no references anywhere in `src/` or `tests/`, not explained by any audit doc,
removal changes no tool's behavior. Exact file/line references given so each can be verified
independently before acting.

### 1. The entire `Result<T>` error-handling pattern in `src/utils/errors.ts`

**What**: `export type Result<T>` (lines 30–33), `export function ok<T>()` (35–37),
`export function err<T = never>()` (39–44), `export function fromAppError<T = never>()` (47–49).

**Why it's dead**: Grepped every import of `../utils/errors.js` across the whole codebase (14
call sites in `src/`, 7 in `tests/`) — every single one imports only `AppError`,
`toStructuredError`, and/or the `StructuredError` type. Zero imports of `ok`, `err`, `Result`, or
`fromAppError` anywhere, including tests. `err()` itself is called exactly once, from inside the
also-dead `fromAppError()` — its only caller is itself dead. `Result<T>` as a type never appears
outside this file either (`grep -rln "Result<" src --include=*.ts` outside `errors.ts`: 0 hits).

The actual, live error-handling convention this codebase uses everywhere is: throw `AppError` →
catch at the tool boundary → `toStructuredError()` → `toolFail()`/`toolOk()`
(`src/tools/tool-result.ts`). `Result<T>`/`ok`/`err`/`fromAppError` is a second, parallel
Result/Either-style convention that was apparently built alongside it and never adopted — every
real call site settled on the exception-based path.

**Impact of removing**: ~20 lines. Zero behavior change — nothing constructs a `Result` today.

**Risk**: None found. Not mentioned in any of the four audit docs (checked). Not part of the
package's public surface — `package.json` has no `types`/`exports` field, only `main`/`bin`
pointing at `dist/index.js`, so this was never externally consumable as a library import either.

### 2. `src/repository/index.ts` (unused barrel file)

**What**: The whole file — re-exports `SUPPORTED_REPOSITORIES`, `GitRepositoryManager`,
`KnowledgeBaseReadinessChecker`, and repository types from the individual files in
`src/repository/`.

**Why it's dead**: Every sibling subsystem's barrel (`src/store/index.ts`, `src/search/index.ts`,
`src/parser/index.ts`, `src/indexer/index.ts`, `src/tools/index.ts`) is the actual import path
`src/server/container.ts` uses (`from '../store/index.js'`, etc.) — that's the pattern this
codebase follows consistently. `repository/index.ts` is the one exception: `container.ts` imports
directly from `../repository/definitions.js`, `../repository/repository-manager.js`,
`../repository/knowledge-base-readiness.js`, and `../repository/types.js` individually,
bypassing this barrel entirely. Confirmed via a full import-graph sweep of every `.ts` file under
`src/`: this is the only non-entry-point file with zero inbound relative imports from anywhere
else in `src/`.

**Impact of removing**: 12 lines, one file. Zero behavior change — nothing resolves through it.

**Risk**: None. Same "no public `types`/`exports` surface" reasoning as item 1 — nothing external
could be importing this barrel either.

### 3. `NotFoundResult` interface — `src/tools/tool-response-helpers.ts:18-24`

**What**: `export interface NotFoundResult { status: 'not_found'; reason: string; message: string;
availableCodes: readonly string[]; sessionId: string; }`.

**Why it's dead**: Zero references anywhere outside its own declaration. The two tools that
actually need a "not found" shape (`explain_finding`, `explore_finding`) each independently
declare their own local `ExplainFindingNotFound`/`ExploreFindingNotFound` interface instead
(`src/tools/explain-finding.ts:89-94`, `src/tools/explore-finding.ts:67-72`) — and those two
shapes (`{findingCode, status, reason: 'unknown_code', message}`) don't even structurally match
`NotFoundResult`'s shape (`{status, reason, message, availableCodes, sessionId}`, no
`findingCode`). This reads as an earlier iteration of the not-found response design that both
real call sites moved past without anyone deleting the original.

**Impact of removing**: 7 lines. Zero behavior change.

**Risk**: None. `tool-response-helpers.ts` isn't re-exported through any barrel
(`src/tools/index.ts` only re-exports from `tool-result.ts`, not `tool-response-helpers.ts`), so
this was never reachable outside this file's own module scope even in principle.

### 4. `CheckEnvironmentInput` type alias — `src/tools/check-environment.ts:13`

**What**: `export type CheckEnvironmentInput = z.infer<typeof CheckEnvironmentInputSchema>;`

**Why it's dead**: Zero references anywhere, including within its own file. `check_environment`
takes no arguments (`CheckEnvironmentInputSchema = z.object({})`, registered in
`register-tools.ts` with an empty `{}` param shape), so nothing ever needed the inferred type —
every other tool's equivalent `XxxInput` type follows the same naming convention and this one was
seemingly added for consistency but genuinely isn't used.

**Impact of removing**: 1 line. Zero behavior change.

**Risk**: None.

### 5. Inert nested `if` block — `src/analysis/insight/priority-action-engine.ts:107-111`

**What**:

```ts
if (hit.severity === 'positive' || hit.severity === 'info') {
  if (!['NoTests', 'HeavySetState', 'MultipleStateLibraries'].includes(def.code)) {
    // allow info only for specific action codes that may be warnings
  }
}
```

inside `PriorityActionEngine.build()`, immediately followed by the line that actually does the
filtering: `if (hit.severity === 'positive') continue;`.

**Why it's dead — provable by inspection, not just by reference-counting**: The inner `if`'s body
is empty except for a comment. No assignment, no `continue`, no `return`, no side effect of any
kind. An `if` statement whose only possible body is empty has no effect on program behavior
regardless of the condition's truth value or `def.code`'s contents — this isn't a "looks unused"
judgment call, it's a logical no-op that can be verified by reading it alone. The comment ("allow
info only for specific action codes that may be warnings") describes an intent that was never
actually implemented — the real filtering three lines later (`if (hit.severity === 'positive')
continue`) doesn't special-case `NoTests`/`HeavySetState`/`MultipleStateLibraries` at all, and
`info`-severity findings currently fall through to being ranked exactly like any other severity
except `positive`. This is a leftover from an abandoned mid-implementation change, not a
completed feature.

**Impact of removing**: 5 lines. Zero behavior change (by construction — deleting a no-op cannot
change behavior).

**Risk**: None. If the *intent* in the comment ("allow info only for specific action codes")
should actually be implemented, that's a real feature decision — but that's a different action
than "clean up this dead block," and is not something to guess at here.

### 6. `src/analysis/rules/rule-engine.ts` — `run()` and `list()` are effectively unreachable code paths

Included here as a partial item, separate from the full-subsystem question (see NEEDS HUMAN
DECISION #1 for the "should the whole RuleEngine layer be removed" question, which is NOT a
mechanical safe-delete). The narrower, unambiguous fact: `RuleEngine.run(snapshot)` — the method
that would actually execute registered rules and return their findings — has **zero callers
anywhere in the codebase or tests** (`grep -rn "\.run(snapshot)"` and equivalents: 0 hits besides
the method's own definition). `RuleEngine.list()` has exactly one caller, and it's `register-builtin.ts`'s
own idempotency check (`if (!ruleEngine.list().some(...))`) — not an external consumer reading the
rule list for a real purpose. If a future cleanup keeps the `RuleEngine` class for its documented
architectural role (see NEEDS HUMAN DECISION #1), `run()` specifically is worth flagging on its
own merits: it is provably never invoked today.

---

## NEEDS HUMAN DECISION

Looks unused, duplicated, or incomplete, but resolving it requires a product/design call this
audit shouldn't make unilaterally — either because the "fix" isn't a deletion, because it touches
a documented architectural component, or because the ambiguity is genuinely about intent, not
about reference-counting.

### 1. `RuleEngine` / `registerBuiltinAnalyzers` — the entire plugin-registry layer is inert scaffolding

**What**: `src/analysis/rules/rule-engine.ts` (40 lines) and `src/analysis/rules/register-builtin.ts`
(109 lines). `ProjectReportBuilder`'s constructor calls `registerBuiltinAnalyzers(this.ruleEngine,
{...})`, which wraps each of the 9 analyzers in an `AnalysisRule` object and pushes it into the
`RuleEngine`'s internal array via `.register()`.

**The gap**: `ProjectReportBuilder.build()` never calls `this.ruleEngine.run(snapshot)`. Instead
it calls every analyzer directly and explicitly:
`this.codeQuality.analyze(snapshot)`, `this.stateManagement.analyze(snapshot)`, ... (9 direct
calls, `project-report-builder.ts:130-138`) — completely bypassing the rule-pack abstraction that
was just built for exactly this purpose. The `RuleEngine` instance ends up holding 9 registered
`AnalysisRule` wrappers that are never read back by anyone.

**Why this isn't a mechanical delete**:

- `README.md`'s architecture diagram explicitly lists `rules/ RuleEngine plugin registry` as an
  intentional component of the documented design — removing it contradicts published
  documentation, not just internal cleanup.
- Removing it touches `ProjectReportBuilder`'s constructor signature, `container.ts`'s DI
  registration, `types/tokens.ts`, `analysis/index.ts`'s barrel export, and 4 test files that
  construct `new RuleEngine()` solely to satisfy that constructor
  (`tests/unit/tools/review-project-explain-top-findings.test.ts`,
  `tests/unit/analysis/analyzers.test.ts`, `tests/unit/analysis/evidence-coverage.test.ts`,
  `tests/unit/analysis/data-reconciliation-bugs.test.ts`) — a multi-file structural change, not a
  single deletion.
- It's ambiguous whether this is genuine leftover cruft or deliberate forward-looking
  extensibility infrastructure (a plugin architecture for future non-built-in rule packs) that
  just hasn't been activated yet. That's a call for whoever owns the project's direction, not
  something inferable from the code alone.

**Recommendation for the human decision**: either (a) actually wire `ProjectReportBuilder` to
call `ruleEngine.run(snapshot)` instead of the 9 direct calls (making the existing scaffolding
real), or (b) remove the `RuleEngine`/`register-builtin.ts` layer and update the README's
architecture diagram to match reality. Leaving it as-is means every future reader of the README
architecture diagram gets a wrong mental model of how findings are actually produced.

### 2. Duplicate, *behaviorally divergent* priority-derivation logic

**What**: Two independently-implemented functions compute a finding's "priority" from the same
inputs (severity, `scoreImpact`, `confidence`), with different thresholds:

- `deriveFindingPriority()` — `src/analysis/insight/project-report-builder.ts:299-314`. Sets
  `finding.priority`, applied once per session when `review_project` builds the report. Its
  "high" tier requires `impact >= 8`.
- `derivePriority()` — `src/analysis/insight/recommendation-engine.ts:106-113`. Sets
  `FindingRecommendation.priority`, recomputed fresh on every `explain_finding`/`explore_finding`
  call via `RecommendationEngine.explainFinding()`/`recommend()`. Its "high" tier is
  `impact >= 8 || confidence >= 0.9` — a strictly broader condition.

**Confirmed reachable, concrete divergence** (not hypothetical): take `DebugPrint`
(`confidence: 0.95`, `scoreImpact: -4`, `severity: 'negative'`). `deriveFindingPriority`: impact
`4 < 8`, severity isn't `'warning'` → falls through to `return 'medium'`. `derivePriority`:
`impact >= 8` is false, but `confidence >= 0.9` is true → returns `'high'`. Traced both into their
actual call sites: `explore-finding.ts:230` reports `priority: match.priority` (the finding's own
field, i.e. `'medium'` for `DebugPrint`); `explain-finding.ts:250` reports `priority: rec.priority`
(the recommendation's field, i.e. `'high'` for the same finding). **`explain_finding` and
`explore_finding` — two tools a caller would reasonably expect to agree — report different
priorities for the identical finding in the identical session.** `DebugPrint` isn't an edge case;
it's one of the most common findings this tool produces.

This is the same category of bug `DUPLICATE_FINDINGS_AUDIT.md` already found and fixed for
finding *emission* (two analyzers independently computing the "same" thing with different
thresholds) — except this instance is in priority *derivation*, and it wasn't caught by that
pass because its scope was finding codes, not derived display fields.

**Why this needs a human decision, not a mechanical fix**: unlike the finding-code duplicates
(where one side was strictly more informative and merging was an easy call), these two formulas
disagree on a genuine judgment question — should high-confidence-but-low-impact findings count as
"high priority"? `derivePriority`'s answer is yes, `deriveFindingPriority`'s is no. There's also a
third factor only `deriveFindingPriority` accounts for: `hasLocatableFileEvidence()` — it won't
grant `'critical'` to a finding that can't point at a real file. Consolidating requires picking
which behavior is correct (or a new, deliberately reconciled one), not just deleting the
"redundant" copy.

### 3. `AnalysisSessionStore.pruneOlderThan()` — a complete feature with zero callers

**What**: `src/analysis/session/analysis-session-store.ts:128-152`. A fully implemented method
that deletes session JSON files older than a given age from `data/analysis-sessions/`.

**The gap**: Not called from anywhere — no tool exposes it, no startup/interval hook invokes it,
no test exercises it (`grep -rn "pruneOlderThan"` across `src/` and `tests/`: only its own
definition).

**This is the inverse of most findings in this report**: it's not leftover code to delete, it's a
*working capability that was never wired up*. Every `review_project`/`analyze_*` call without a
matching `sessionId` writes a new session file (`AnalysisSessionStore.save()`) and nothing ever
removes old ones — `data/analysis-sessions/` grows unboundedly over a long-running server's
lifetime. This is the same shape of issue `AUDIT_FINDINGS.md` #8 already flagged for
`RepositoryManager.updateOne()` (a real, useful method that no caller reaches).

**Why this needs a human decision**: the right fix is "wire this up," but *how* is a product
choice this audit shouldn't make unilaterally — a periodic background sweep on server startup, an
explicit maintenance tool, a cap on session-file count instead of age, or intentionally leaving
disk cleanup to the operator (many local stdio-tool servers do). Recommend flagging this for a
follow-up decision, not touching the code.

### 4. `SymbolRecord` / `DocRecord` — barrel-exported but never used as a concrete return type

**What**: `src/store/types.ts:39-58` (`SymbolRecord`, `DocRecord`), both re-exported via
`src/store/index.ts`.

**The ambiguity**: this "family" of DB-row-shape types has 4 members — `RepositoryRecord`,
`FileRecord`, `SymbolRecord`, `DocRecord`. `RepositoryRecord` and `FileRecord` are genuinely used
as method return types in `sqlite-store.ts` (`getFileByPath(): FileRecord | null`,
`upsertRepository(): RepositoryRecord`, etc.). `SymbolRecord` and `DocRecord` are not — the
corresponding methods (`findSymbols`, `findDocs`) return the differently-shaped
`SymbolSearchHit`/`DocSearchHit` types instead, and no code ever constructs or returns a raw
`SymbolRecord`/`DocRecord`.

**Why this needs a human decision rather than a delete**: this could be (a) genuine leftover from
an earlier store-layer design that never got finished symmetrically, or (b) deliberate
schema-mirroring — every SQLite table gets a matching row-shape type for consistency/future use
(e.g. a future `getSymbolById()` accessor), even if not everything is consumed yet. The pattern
(2 of 4 used, 2 of 4 not) doesn't resolve that question by itself, and the removal value is tiny
either way (~20 lines) — not worth guessing at intent for.

### 5. `ProjectHealthScorer` — one-method delegation facade, self-documented as "back-compat"

**What**: `src/analysis/insight/project-health-scorer.ts` — the entire class is a single `score()`
method that does nothing but call `this.scoring.score(input)` on the injected `ScoringEngine`.
Its own doc comment: *"Back-compat facade — delegates to ScoringEngine for transparent
contributors."*

**Why this isn't flagged as bloat outright**: it's not duplicate logic (there's exactly one
scoring implementation, in `ScoringEngine`), and it's explicitly self-documented as an
intentional compatibility layer, not an accident. The only question is whether the thing it's
"back-compat" *for* still needs preserving — `ProjectHealthScorer` is what `ProjectReportBuilder`
actually injects (`@inject(TYPES.ProjectHealthScorer)`, `project-report-builder.ts:97`), so
collapsing it to inject `ScoringEngine` directly is a same-behavior simplification, but touches
DI wiring and is genuinely low-value (one 20-line file, one indirection hop) — flagging for
awareness, not urging action.

---

## DO NOT TOUCH

Flagged during investigation, then correctly ruled out — kept here as a record of what was
considered, so a future pass doesn't have to re-derive the same reasoning.

1. **Unrestricted target `path` argument** on `review_project`/`analyze_*`. Looks like missing
   input validation; explicitly a documented design decision — `SECURITY_DECISIONS.md` §1.

2. **`UNTRUSTED_CONTENT_NOTE` / `BASIS_NOTE` / `BASIS_SHORT_NOTE`** — large inline string literals
   in `register-tools.ts` (98-119) repeated across many tool descriptions. Looks like copy-paste
   bloat; each is a deliberate, load-bearing security/interpretability signal —
   `SECURITY_DECISIONS.md` §2 and `AUDIT_FINDINGS.md` #9 for `UNTRUSTED_CONTENT_NOTE`; the basis
   notes exist specifically so a calling agent doesn't misread confidence, per `CONFIDENCE_AUDIT.md`'s
   whole premise.

3. **`dart-sdk-locator.ts`'s multi-location fallback search** (config override → known install
   locations → PATH). Looks like an overly complex detection chain that could be simplified to
   "just check PATH"; it exists specifically because PATH-only detection was a real, previously
   diagnosed silent-failure bug — `SECURITY_DECISIONS.md` §3.

4. **Full `process.env.PATH` logging** at startup in `DartAnalyzerClient` (`dart-analyzer-client.ts:93-94`
   area). Looks like excess/risky diagnostic verbosity; confirmed intentional and scoped —
   `SECURITY_DECISIONS.md` §4, `AUDIT_FINDINGS.md` #10.

5. **`AnalysisSessionStore.get()`'s `SESSION_ID_PATTERN` hex-format guard**
   (`analysis-session-store.ts:76-87`). Looks like defensive boilerplate for an input that's
   "always" well-formed; it closes a confirmed, previously-exploitable path-traversal bug —
   `AUDIT_FINDINGS.md` #2. The inline `SECURITY:` comment at the call site already documents this;
   preserved that context rather than repeating it here.

6. **`ProjectScanner`'s `followSymbolicLinks: false` + realpath containment check +
   `MAX_FILE_BYTES`/`MAX_DART_FILES` caps** (`project-scanner.ts`). Looks like defensive-in-depth
   bloat for a single glob call; each closes a specific, confirmed finding —
   `AUDIT_FINDINGS.md` #3 (symlink escape) and #6 (resource exhaustion / unbounded file count).

7. **`detectCycles()`'s explicit-stack iterative DFS** (`src/analysis/engines/detect-cycles.ts`).
   The manual frame-stack implementation is more verbose than a naive recursive DFS and could
   look like unnecessary complexity; it's a deliberate stack-overflow-DoS fix
   (`AUDIT_FINDINGS.md` #6) and is already the single shared implementation both
   `ArchitectureAnalyzer` and `DependencyAnalyzer` import — confirmed this is the **already-fixed**
   state of `DUPLICATE_FINDINGS_AUDIT.md` #5 (that doc's own copy-pasted-recursive-`detectCycles`
   finding no longer applies; the fix landed).

8. **`RepositoryManager.updateOne()` bypassing `inProgressSet`** (`repository-manager.ts:108-111`).
   By pure reference-counting this is currently unreachable from any registered tool — but
   `AUDIT_FINDINGS.md` #8 already flags it as "a live regression risk if ever wired to a tool,"
   not as removable dead code. The correct fix per that doc is adding the missing
   check-then-act guard, not deleting the method — left untouched and out of the SAFE TO
   REMOVE list for that reason.

9. **`CodeQualityFacts.godClassCandidates` (string-array field) and its `?? facts.godClassCandidates.length`
   fallback reads** in `src/tools/analyze-code-quality.ts:107` and
   `src/analysis/debt/technical-debt-engine.ts:21`. `evidence-engine.ts:123`'s own comment calls
   this "the separate, unused `godClassCandidates` legacy field," which reads like a
   self-flagged removal candidate — but tracing the two read sites shows it's a genuine,
   still-necessary defensive fallback: `AnalysisSessionStore` caches full report JSON via
   `JSON.parse` **cast, not runtime-validated**, to `StoredAnalysisSession`
   (`AUDIT_FINDINGS.md` #2/#7 context) — a `sessionId` from an *older* cached session (saved by a
   prior server version, before `godClassDetails` existed) could genuinely lack that field at
   runtime even though the current TS type declares it non-optional. The `??` fallback prevents a
   crash reading such a session. Confirmed still load-bearing for backward-compatible session
   reads; the evidence-engine.ts comment is about that one regex branch specifically (which really
   is unused for its narrow original purpose), not about the field being globally dead.

10. **Verbose per-tool `XxxInput`/`XxxData`/`XxxHit` type exports** across `src/tools/*.ts`
    (e.g. `FindWidgetInput`, `AnalyzeCodeQualityData`, `SearchDocsHit`, ~60 instances found via a
    full exported-symbol sweep). These are only referenced within their own declaring file — but
    this is normal, idiomatic TypeScript for a Zod-schema-backed handler's own input/output types,
    not bloat. Removing the `export` keyword would save nothing meaningful and isn't worth the
    diff noise; not included as a finding.

11. **Exact-pinned `better-sqlite3`/`simple-git` versions** in `package.json` (no `^` prefix,
    unlike every other dependency). Looks like an inconsistency; it's the already-applied fix for
    `AUDIT_FINDINGS.md` #11 Gap 1 (native-binary and subprocess-spawning packages specifically
    called out as worth pinning exactly).

12. **`ArchitectureMatchEngine` vs. `ArchitectureAnalyzer`'s own `detectedArchitecture` field** —
    at first glance two independent architecture-detection computations, which would fit the
    "duplicate logic" pattern this audit was asked to look for. Not a duplicate: the analyzer's
    own field is explicitly a single-candidate seed value, and `project-report-builder.ts:174-190`'s
    own comment documents the reconciliation — `ArchitectureMatchEngine` is the authoritative,
    multi-candidate scorer, and the merged findings array is realigned to its result specifically
    so the two never disagree. Already correctly designed, not left over.

13. **All 5 `DUPLICATE_FINDINGS_AUDIT.md` finding-code collisions** (`LargeBuildMethod`,
    `UndocumentedWidgets`, `HasAnalysisOptions`, `ConstOpportunities`→`LegacyNewKeywordUsage`,
    `CircularDependencies`). Checked each one's current state directly in
    `code-quality-analyzer.ts`/`documentation-analyzer.ts`/`performance-analyzer.ts`/
    `architecture-analyzer.ts`/`dependency-analyzer.ts` — all 5 fixes are already applied (explicit
    "NOTE: ... intentionally does NOT emit a finding here" comments at each removed emission site,
    confirming which analyzer now owns each code). Nothing further to do; not re-flagged.

---

## A process note (not a code finding)

Every SAFE TO REMOVE item above passed `npm run lint`/`npm run typecheck` cleanly in the current
codebase — `noUnusedLocals`/`noUnusedParameters` (tsconfig.json) and
`@typescript-eslint/no-unused-vars` (eslint.config.js) only catch unused *locals*, not unused
*exports*, so none of this was ever going to surface through existing tooling. Worth knowing
before assuming "lint is clean" means "no dead code" for this codebase specifically. (Not a
recommendation to add a new tool in this pass — just noting why these accumulated.)

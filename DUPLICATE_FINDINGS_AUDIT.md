# Duplicate Finding Codes — Audit

Audit date: 2026-08-07. Scope: every `finding(...)` call site across all 9 analyzer engines
(`src/analysis/engines/*.ts`). Method: extracted every `code: '...'` literal from every
`finding(...)` call (79 emission sites total), grouped by code value, read every call site for
codes appearing more than once, and traced each into `ScoringEngine` to check whether the
duplication also corrupts a numeric score (not just the findings array).

## Method note: why this matters beyond "two entries look weird"

`report.findings` is a single **merged** array across all 9 analyzers
(`ProjectReportBuilder` — `merged = merged.slice(0, limit)`), not per-analyzer sections. So any
duplicate code doesn't just show up twice in a "detailed" view while a "summary" view stays
clean — both copies land in the exact same flat array, which is exactly the symptom reported
(`analyze_code_quality` on NLDCMobileApp: `LargeBuildMethod` twice, different titles/scoreImpact).

Worse: `ScoringEngine.scoreCodeQuality()` computes the `codeQuality` health score by summing
`scoreImpact × confidence` over every finding in the merged array whose `category` is one of
`['oop', 'solid', 'dart', 'flutter', 'data_structures']` — filtered by **category**, not by
which analyzer emitted it. Three of the five duplicates below use a category in that list, so
for those, the bug isn't just cosmetic — it's **double-counted directly into the numeric
codeQuality score** (and from there into `maintainability`/`overall`, which weight `codeQuality`
at 0.35/0.2). Per-analyzer scores that are computed from that analyzer's own **facts** (not from
re-filtering the merged findings array — `performanceScore`, `documentationScore`, `architecture`
value, `scalability` value) are *not* directly corrupted this way; only `scoreCodeQuality`'s
value is, because it's the one score function that indiscriminately sums by category across the
whole merged array. `scoreArchitecture`'s displayed *confidence* (not its numeric value) is also
mildly skewed by the `CircularDependencies` duplicate via `avgConfidence(findings, ['architecture','dependency'])`.

## Duplicates found (5 exact-code collisions)

### 1. `LargeBuildMethod` — classification (a): genuine bug, merge

| Emission | File:line | Category | Title | scoreImpact | Threshold/scope |
| --- | --- | --- | --- | --- | --- |
| A | `code-quality-analyzer.ts:291` | `flutter` | "Large Widget.build methods" (static) | fixed `-10` | ≥80 lines, **all** dartFiles, first `build(` per file |
| B | `performance-analyzer.ts:119` | `flutter` | `` `${count} build() method(s) exceed 60 lines` `` (dynamic) | `-15` if >10 else `-8` | >60 lines, **lib/ only**, longest `build(` per file |

Both scan for oversized `Widget build()` methods via near-identical brace-depth counters
(`estimateMethodLength` vs `extractBuildMethodLines`) — same underlying signal, independently
reimplemented with different thresholds (60 vs 80) and different file scope (all files,
including `test/`, vs `lib/`-only). **Double-counted into `codeQuality` score** (both
category `flutter`, both picked up by `scoreCodeQuality`'s filter).

Positive counterparts also collide in spirit (different codes, same redundancy):
`BuildMethodsReasonable` (code-quality-analyzer.ts:314) vs `CompactBuildMethods`
(performance-analyzer.ts:139) — not an exact code match, so not caught by the grep, but the same
root cause and addressed the same way below.

### 2. `UndocumentedWidgets` — classification (a): genuine bug, merge

| Emission | File:line | Category | Title | scoreImpact | Notes |
| --- | --- | --- | --- | --- | --- |
| A | `code-quality-analyzer.ts:398` | `dart` | "Widgets without /// docs" (static) | fixed `-2` | No ratio scaling |
| B | `documentation-analyzer.ts:101` | `flutter` | `` `${n} of ${total} widget(s) lack doc comments` `` (dynamic) | `-12` if ratio>0.5 else `-6` | Ratio-scaled, confidence reflects `ast.source` |

Both compute `widgets.filter(w => !w.docstring)` from the same `snapshot.symbols` — literally
the same input, same predicate. B is strictly more informative (dynamic title with real counts,
severity/impact that scales with how bad it is, confidence that reflects AST reliability) — A is
a cruder, static-impact duplicate. **Double-counted into `codeQuality` score**: `scoreCodeQuality`
filters categories `['oop','solid','dart','flutter','data_structures']`, which includes *both*
`dart` and `flutter` — so both copies get summed regardless of the category difference.

### 3. `HasAnalysisOptions` — classification (a): genuine bug, merge

| Emission | File:line | Category | Title | scoreImpact |
| --- | --- | --- | --- | --- |
| A | `code-quality-analyzer.ts:503` | `dart` | "Has analysis_options.yaml" | `+3` |
| B | `documentation-analyzer.ts:162` | `dart` | "analysis_options.yaml is configured" | `+8` |

The simplest case: both read the exact same pre-computed boolean (`snapshot.hasAnalysisOptions`)
— not even independently derived, just the same flag checked twice. **Double-counted into
`codeQuality` score** (both category `dart`).

Note the *negative* branches of this same `if/else` did **not** collide by accident:
`NoAnalysisOptions` (code-quality-analyzer.ts:484) vs `MissingAnalysisOptions`
(documentation-analyzer.ts:144) — different code strings for the same missing-file condition.
That's not a name collision, but it's the identical bug in spirit (same boolean, reported twice
under different wording) and is fixed the same way below for consistency — leaving it half-fixed
(negative branch duplicated-but-not-code-colliding, positive branch code-colliding) would be a
worse end state than fixing both branches together.

### 4. `ConstOpportunities` — classification (b): different signals, shared code by accident, disambiguate

| Emission | File:line | Category | Title | Measures |
| --- | --- | --- | --- | --- |
| A | `code-quality-analyzer.ts:377` | `dart` | "Many widgets may be const-eligible" | Widget constructor calls (`Text(`, `Container(`, ...) missing `const`, tolerance of 5 |
| B | `performance-analyzer.ts:159` | `flutter` | `` `~${n} potential 'const' widget opportunities (using 'new')` `` | Literal legacy `new Foo(...)` keyword usage |

**Not the same metric.** A detects modern constructor calls that could be `const` but aren't. B
specifically detects the old, now-optional `new` keyword — a different, narrower code smell (you
can use `new Widget()` without it being const-eligible in A's sense, and vice versa). They ended
up sharing a code purely by naming coincidence, not because they're the same finding. This is
exactly the "shared code, different meaning" failure mode: `explore_finding`/`explain_finding`
look up a finding by `code`, so calling either with `code: 'ConstOpportunities'` returns
whichever of these two unrelated findings happens to be first in the array — unpredictable, and
silently wrong the rest of the time.

### 5. `CircularDependencies` — classification (a): genuine bug (copy-pasted algorithm), merge

| Emission | File:line | Category | Title | scoreImpact |
| --- | --- | --- | --- | --- |
| A | `architecture-analyzer.ts:310` | `dependency` | "Circular import dependencies detected" (static) | fixed `-15` |
| B | `dependency-analyzer.ts:180` | `dependency` | `` `${n} circular import cycle(s) detected` `` (dynamic) | `-10` |

This is the case referenced as "a prior review flagged CircularDependencies showing inconsistent
scoreImpact values across different payload sections" — confirmed, and the root cause is worse
than a simple duplicate: `architecture-analyzer.ts` has its **own copy-pasted `detectCycles()`**
(`architecture-analyzer.ts:510-549`) — a near-line-for-line duplicate of the recursive DFS that
used to live in `dependency-analyzer.ts` before the security-hardening pass converted it to an
explicit-stack iterative version to close a stack-overflow DoS risk on long import chains (see
that pass's `DUPLICATE_FINDINGS_AUDIT`-adjacent finding — er, `AUDIT_FINDINGS.md` #6).
**`architecture-analyzer.ts`'s copy was never converted** — the recursion-depth DoS this codebase
already fixed once is still reachable through this second, independently-copy-pasted
implementation. Not double-counted into `scoreCodeQuality` (category `dependency` isn't in its
filter list), but does skew `scoreArchitecture`'s displayed confidence
(`avgConfidence(findings, ['architecture', 'dependency'])` averages in both copies' confidence).

## Connection to the officialReferences keyword-collision issue

Checked, as requested. `PresentationImportsData` (the finding named in that prior self-review)
calls `this.refs.lookupDoc('clean architecture')` — a **fixed keyword string**, not the finding's
own title. `OfficialReferenceResolver.lookupDoc()` resolves that keyword via
`KnowledgeStore.findDocs({ query, ... })`, which does a SQL `LIKE '%query%'` substring match
against doc chunks/titles and returns the first hit. That's a genuinely different mechanism from
finding-code duplication — no finding code is involved in officialReference resolution at all,
and the analyzer code doesn't pass the finding's title into `lookupDoc`/`lookupSymbol` anywhere
checked.

**They share a root-cause *category*** (both are instances of "loose, non-exact matching
produces an unintended result" — LIKE-substring search on one side, duplicate/coincidental string
identity on the other), but they are not the same code path, don't compound each other, and
fixing one doesn't fix the other. Per scope, `officialReferences` matching is not touched in this
pass.

## Summary table

| Code | Classification | Fix |
| --- | --- | --- |
| `LargeBuildMethod` | (a) merge | Keep `performance-analyzer.ts` (lib/-scoped, dynamic title/impact); remove code-quality-analyzer.ts's emission (keep its fact for the fallback path in `scorePerformance`). Also fixed performance-analyzer.ts's evidence format (`file:line (~N lines)`, was missing the line number) and raised its evidence cap 5→10, so it now satisfies `EvidenceEngine.parseEvidenceString`'s build-method regex the way code-quality-analyzer.ts's version used to — without this, evidenceItems for this finding would have silently degraded to unstructured entries |
| `UndocumentedWidgets` | (a) merge | Keep `documentation-analyzer.ts` (ratio-scaled); remove code-quality-analyzer.ts's emission (keep its fact) |
| `HasAnalysisOptions` | (a) merge | Keep `documentation-analyzer.ts`; remove code-quality-analyzer.ts's entire analysis_options finding block (both branches, for consistency with the non-colliding negative codes) |
| `ConstOpportunities` | (b) disambiguate | Rename `performance-analyzer.ts`'s code to `LegacyNewKeywordUsage` (it measures a different, narrower signal) |
| `CircularDependencies` | (a) merge + latent DoS gap | Keep `dependency-analyzer.ts`; remove architecture-analyzer.ts's emission (keep its fact); extract the now-shared `detectCycles` into one iterative implementation both analyzers import, closing the unconverted-recursion gap |

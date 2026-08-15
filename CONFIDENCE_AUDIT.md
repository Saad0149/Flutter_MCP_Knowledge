# Confidence Audit — `pattern` and `heuristic_fallback` basis findings

**Scope:** every finding across the 9 analyzers currently declared `basis: 'pattern'`
(always pattern-based, regardless of AST availability) or `basis: astOrFallback(ast)`
(AST-backed when the real Dart AST is available, `heuristic_fallback` otherwise). 42
finding codes total: 33 static `'pattern'`, 9 dynamic.

**This is investigation only. No analyzer logic, scoring, or confidence value was
changed in this pass.** See the closing statement at the bottom for confirmation of
exactly what was and wasn't touched.

## Standing limitation (read this before the table)

Every confidence number audited below is a hand-picked constant chosen by whoever wrote
the analyzer — not derived from testing against real, varied codebases and measuring
how often the finding was actually correct. This is verified, not assumed: there is no
calibration harness, confusion-matrix test, or ground-truth validation suite anywhere in
this repository (`git log` has exactly one commit mentioning "confidence" — the basis
type work itself — and zero mentioning "calibrat*"). Every finding in this tool has, at
most, been checked by hand against two projects: NLDCMobileApp and al-nasser-app —
structurally near-identical codebases from the same team, heavily copy-pasted from one
another, not independent or varied. **No finding in this tool has been validated against
a real, varied set of codebases with known ground truth.** This applies uniformly to
every row below (Bucket C, per the task framing) and is stated once here rather than
repeated 42 times.

## What "Bucket A" actually requires here

The Dart-side helper (`parser/bin/extract_symbols.dart`) currently calls
`session.getParsedUnit(absolute)` — a **syntactic parse only**, not
`getResolvedUnit()`. It runs no type resolution, no constant evaluation, no lint rules,
and its `RecursiveAstVisitor` only overrides declaration-level visits (class/mixin/enum/
extension/function declarations) — it never descends into method bodies to capture
statements or expressions. `dart-analyzer-client.ts`'s `AnalyzerSymbol` surface is
correspondingly thin: name, kind, line, isWidget, docstring, packageName, and the three
clause strings (extends/with/implements). **None of the Bucket A candidates below can be
built from data already flowing through this pipeline.** Every one of them needs one of
two real changes, noted per-row:

- **Parsed-level extension** (moderate): teach the existing visitor to also capture
facts from method bodies or constructor-call arguments — still just syntax, no import
resolution, no `getResolvedUnit()` switch. Cheaper, but still new visitor code plus a
new field on `AnalyzerSymbol`/a new payload shape, plus corresponding TS-side parsing.
- **Resolved-level / real lint execution** (larger): switch to `getResolvedUnit()` (real
type resolution, resolves the whole import graph — meaningfully slower per file) and/or
actually run `LintRule`s via `package:analyzer`'s lint infrastructure instead of
hand-rolling regex approximations of what those lints already do precisely.

## Full per-finding table

| Code                            | Analyzer         | Confidence | Bucket                                            | What actually computes it                                                                                                                                                                                        | Question it's answering                                                      |
| ------------------------------- | ---------------- | ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| NoSemanticsWidgets              | accessibility    | 0.85       | B                                                 | Regex-counts `Semantics(`/`Tooltip(`/`MergeSemantics(` constructor calls; fires when the sum is 0 across >3 lib files                                                                                            | Does this app use zero explicit accessibility annotations?                   |
| SemanticsWidgetsPresent         | accessibility    | 0.85       | B                                                 | Same counters, positive branch                                                                                                                                                                                   | Does this app use *some* accessibility annotations?                          |
| ImagesWithoutSemanticLabels     | accessibility    | 0.65       | B (detection precision is A-able)                 | Counts `Image.network|asset|file|memory(` calls minus `semanticLabel:` occurrences **file-wide** — a label anywhere cancels an image anywhere in the same file                                                   | How many images plausibly lack a semantic label?                             |
| IconButtonsWithoutTooltip       | accessibility    | 0.65       | B (detection precision is A-able)                 | Same file-wide subtraction pattern for `IconButton(` vs `tooltip:`                                                                                                                                               | How many icon buttons plausibly lack a tooltip?                              |
| CustomPainterAccessibility      | accessibility    | 0.75       | B                                                 | Presence of `CustomPainter` anywhere in file; severity `info`, purely advisory                                                                                                                                   | Should someone go check this CustomPainter's semantics manually?             |
| DebugPrint                      | code-quality     | 0.95       | **A**                                             | `\bprint\s*\(` text match, doesn't confirm the call resolves to `dart:core`'s `print` (an `obj.print()` method would also match)                                                                                 | Does this file call the global `print()` function outside `test/`?           |
| LegacyButtonApi                 | code-quality     | 0.98       | **A**                                             | Literal class-name regex `RaisedButton|FlatButton|OutlineButton`                                                                                                                                                 | Does this file reference a removed/legacy Material button class?             |
| ConstOpportunities              | code-quality     | 0.65       | **A** (the task's own canonical example)          | Regex-counts common widget constructor calls with vs. without a leading `const`                                                                                                                                  | How many widget constructor calls are missing `const`?                       |
| ModernClassModifiers            | code-quality     | 0.92       | B — but syntactically near-exact already          | `/^\s*(sealed|final|base)\s+class\b/` line match                                                                                                                                                                 | Does this project use sealed/final/base class modifiers?                     |
| PatternMatching                 | code-quality     | 0.75       | B — but syntactically near-exact already          | Regex for switch/case arrow (`=>`) syntax                                                                                                                                                                        | Does this project use modern pattern-matching switch syntax?                 |
| CollectionUsage                 | code-quality     | 0.7        | B (not a defect check at all)                     | Regex-counts `List`/`Map`/`Set` mentions; severity `info`                                                                                                                                                        | Roughly how much are List/Map/Set used?                                      |
| LargeFiles                      | complexity       | 0.9        | B                                                 | `file.lineCount >= 300` — exact count, arbitrary threshold                                                                                                                                                       | Does this file exceed a 300-line size threshold?                             |
| WellSizedFiles                  | complexity       | 0.85       | B                                                 | Same, negative branch                                                                                                                                                                                            | Are all files under 300 lines?                                               |
| HighComplexityFiles             | complexity       | 0.65       | **A**                                             | Regex-counts `if|else|for|while|do|switch|case|catch|&&||||?` tokens across raw text — includes matches inside strings/comments, and conflates the `?`in nullable types (`String? x`) with the ternary operator | Roughly how cyclomatically complex is this file?                             |
| DeepNesting                     | complexity       | 0.6        | **A**                                             | Counts `{`/`}` brace depth across the **whole file**, not scoped to control-flow blocks — deeply nested map/list literals count the same as nested `if`s                                                         | How deeply nested is this file's code?                                       |
| MultiResponsibilityWidgets      | complexity       | 0.65       | B (attribution precision is A-able)               | Regex for `http.|dio.|Firestore|supabase|sqflite|Repository|Service|ApiClient|...` anywhere in a file, attributed to **every** widget symbol in that file regardless of which class the match is actually inside | Does this widget mix UI and business/network logic?                          |
| HugeWidgets                     | complexity       | 0.9        | B                                                 | `file.lineCount >= 600` for files containing a widget symbol — exact count, arbitrary threshold                                                                                                                  | Does this widget's file exceed 600 lines?                                    |
| LowInlineComments               | documentation    | 0.8        | B                                                 | Counts lines starting with `//` (misses block comments) ÷ total lines, thresholded at 3%                                                                                                                         | Is inline comment density unusually low?                                     |
| LargeBuildMethod                | performance      | 0.8        | **A**                                             | Manual brace-matching to find `build()`'s extent, then counts lines >60                                                                                                                                          | How many lines does this widget's build() method span?                       |
| CompactBuildMethods             | performance      | 0.75       | **A**                                             | Same computation, negative branch                                                                                                                                                                                | Are all build() methods under 60 lines?                                      |
| LegacyNewKeywordUsage           | performance      | 0.7        | B — but syntactically exact already               | `(?<![A-Za-z])new\s+[A-Z]` — `new` is a reserved word, essentially unambiguous                                                                                                                                   | Does this project use the legacy `new` keyword before widget constructors?   |
| HeavySetStateUsage              | performance      | 0.7        | B (well-defined anti-pattern, no lint exists)     | `setState\([^)]*(?:await|http\.|Firestore|supabase|sqflite|compute\()` — args-scoped, reasonably tight                                                                                                           | Does `setState(...)` wrap async/network work directly?                       |
| AnimationControllerLeak         | performance      | 0.7        | **A** (larger effort)                             | Presence of `AnimationController(` **and** absence of `dispose()` **anywhere in the file** — doesn't confirm the same field is disposed in the same class's `dispose()`                                          | Is this AnimationController left undisposed?                                 |
| ListViewBuilderMisuse           | performance      | 0.75       | **A**                                             | `ListView\(children:\s*\[` named-argument presence                                                                                                                                                               | Does this file construct `ListView(children: [...])` eagerly?                |
| ImageWithoutCacheHints          | performance      | 0.7        | B (detection precision is A-able)                 | Same file-wide subtraction pattern as ImagesWithoutSemanticLabels, for `Image.network(` vs `cacheWidth|cacheHeight|CachedNetworkImage`                                                                           | How many network images plausibly lack cache sizing?                         |
| MultipleStateLibraries          | state-management | 0.88       | B                                                 | Per-**feature** (folder-scoped, not per-file) aggregation of riverpod/bloc/provider/getx regex hits                                                                                                              | Are 2+ state libraries mixed inside one feature folder?                      |
| MultipleStateLibrariesAcrossApp | state-management | 0.8        | B                                                 | Same signals, app-wide instead of per-feature                                                                                                                                                                    | Are 2+ state libraries used across the app (not necessarily co-located)?     |
| HeavySetState                   | state-management | 0.78       | B                                                 | `isProblematicSetStateContext`: async/storage keyword **anywhere in the file**, OR **any** file with ≥8 `setState(` calls is marked entirely "problematic"                                                       | Is `setState` usage in this file tangled with shared/network/business state? |
| ModestSetState                  | state-management | 0.8        | B                                                 | Same function, negative branch                                                                                                                                                                                   | Does `setState` usage in this file look purely local/ephemeral?              |
| MissingDispose                  | state-management | 0.7        | **A** (larger effort)                             | Controller-type-name mention anywhere in file, **and** zero `void dispose(` anywhere in file — no class-scoping                                                                                                  | Is a controller-like field left undisposed?                                  |
| HasDisposeMethods               | state-management | 0.75       | **A** (larger effort)                             | Same signals, positive branch                                                                                                                                                                                    | Are dispose() methods present near controller-like fields?                   |
| LogicInWidgets                  | state-management | 0.72       | B (attribution precision is A-able)               | `(path.includes('widget') || extends State<) && (http.|Dio(|FirebaseFirestore|.collection(|Repository()` anywhere in file                                                                                        | Does this widget/State file contain data/network logic?                      |
| Scores                          | state-management | 0.85       | **See note below — not a real "confidence" case** | A weighted-sum formula over several of the above heuristics, with hand-picked weights (e.g. `-12 if problematicSetStateSites > 15`)                                                                              | What are this file's maintainability/scalability composite scores?           |

### Dynamic (`astOrFallback`) findings — audited as they behave in `heuristic_fallback`

These 9 are **already AST-backed by design** — they read `snapshot.symbols` (the real
Dart AST's declaration table when `dart_analyzer` succeeded) and only degrade to
`heuristic_fallback` when this scan's `astMeta.source` was `'heuristic'`. Their
remediation is **operational** (get `dart_analyzer` working — `check_environment`
already exists for this), not a Bucket A engineering project. Two of them, however, turn
out to have a real, independent problem worth flagging regardless of AST state:

| Code                          | Analyzer         | Confidence                                     | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UsesMixins                    | code-quality     | 0.95                                           | Reads `symbol.kind==='mixin'`. Fallback regex targets the unambiguous `mixin X {` keyword — reliable even degraded.                                                                                                                                                                                                                                                                                                                                                                                                               |
| UsesExtensions                | code-quality     | 0.95                                           | Same reasoning, `extension X on Y {`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| LargeClassCandidate           | code-quality     | 0.85                                           | Reads the real class list + exact `file.lineCount`; fallback class-discovery can miss unusual formatting.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GodClassCandidate             | code-quality     | computed (≤0.95)                               | **Not fully AST-backed even in** `basis:'ast'` **mode.** Class *discovery* uses the real symbol table, but `scoreGodClass()`'s method/field/import-count and "responsibility hints" signals are **always** regex over raw file content — `basis:'ast'` here only means "we found the class via real symbols," not "the score is AST-derived." The per-instance confidence formula itself (`0.55 + score/200 + bonus`) is another hand-picked constant.                                                                            |
| DeepInheritance               | code-quality     | 0.7                                            | `inheritanceDepthHint()` does not walk the ancestor chain at all — it counts whitespace-split tokens in the class's own single `extends` clause string, which is not a measure of inheritance depth in any real sense. This looks like a correctness bug in the heuristic, independent of AST availability. Real chain-walking for project-local ancestors is achievable today with **zero new Dart-side capability** — the symbol table already has every class's own `extendsClause`; it just isn't being followed recursively. |
| ChangeNotifierWithoutProvider | state-management | 0.8                                            | Reads `symbol.extendsClause.includes('ChangeNotifier')` (solid when AST available); "without provider" is judged from whole-project provider/riverpod hint counts, not scoped to this specific notifier.                                                                                                                                                                                                                                                                                                                          |
| DetectedApproaches            | state-management | 0.98 (pubspec branch) / 0.75 (fallback branch) | The pubspec-dependency branch is a deterministic fact-check (already effectively `'ast'`, not really `'pattern'`). Only the 0.75 fallback branch (no clear pubspec signal → regex-guess from StatefulWidget/setState/library-specific code patterns) is in scope here.                                                                                                                                                                                                                                                            |
| UndocumentedWidgets           | documentation    | 0.92 (ast) / 0.7 (fallback)                    | Real doc-comment attachment when AST available; fallback regex for `///` immediately preceding a declaration can miscount a copyright header or miss docs separated by blank lines/annotations.                                                                                                                                                                                                                                                                                                                                   |
| WellDocumentedWidgets         | documentation    | 0.92 (ast) / 0.7 (fallback)                    | Same computation, positive branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Strongest Bucket A candidates (highest value to upgrade first)

1. **ConstOpportunities** — maps directly to `prefer_const_constructors` /
  `prefer_const_constructors_in_immutables` (official `package:lints`/`flutter_lints`
   rules). Real work: **resolved-level**. Const-eligibility requires actual constant
   evaluation of the constructor's arguments; the current regex can't tell whether adding
   `const` would even compile. Needs `getResolvedUnit()`, not just visitor coverage.
2. **DebugPrint** — maps directly to `avoid_print`. Real work: **resolved-level** (need
  symbol resolution to confirm the call target is `dart:core`'s `print`, not some
   object's own `.print()` method), though the practical false-positive rate is probably
   already low.
3. **LegacyButtonApi** — maps to `deprecated_member_use` conceptually. Real work:
  **resolved-level**, and only meaningful for projects pinned to an older Flutter SDK
   where these classes are deprecated rather than fully removed (on current SDKs the
   project likely wouldn't compile with these names at all, which is itself worth
   confirming before investing here).
4. **HighComplexityFiles / DeepNesting** — no official lint to reuse, but real
  McCabe-style complexity and real block-nesting depth are both standard, deterministic,
   **parsed-level** computations (no type resolution needed) — the cheapest tier of
   Bucket A work here, and the current versions have a concrete correctness gap (string/
   comment false positives, nullable-type `?` miscounted as a branch).
5. **DeepInheritance** — zero new Dart-side capability required. The bug is on the TS
  side: the symbol table already carries each class's `extendsClause`; walking it
   recursively for project-local ancestors is a same-session fix once someone decides to
   act on this audit. Flagged here because it's cheap, not because it's high-impact.
6. **LargeBuildMethod / ListViewBuilderMisuse** — parsed-level, no official lint, but
  exact method-body span and named-argument matching are mechanical AST facts once the
   visitor is extended to descend into method bodies / constructor arguments.
7. **MissingDispose / AnimationControllerLeak** — larger effort (needs method-body flow
  tracking: does *this* class's `dispose()` call `.dispose()` on *this* field), no
   official lint, but a well-known, low-ambiguity anti-pattern once properly scoped.

## Bucket B findings whose current confidence looks miscalibrated

- `Scores` **(state-management, confidence 0.85)** — this isn't a detection with a real
accuracy rate at all; it's an editorial weighted-sum formula over other heuristics'
outputs, with hand-picked weight constants (e.g. `-12` if `problematicSetStateSites > 15`, `-8` otherwise). Attaching a confidence number to a composite formula is a
category error, not just an uncalibrated judgment call — there's no sense in which this
"finding" is right or wrong the way a detection can be. Worth flagging as the single
clearest case in this audit of a confidence number that shouldn't exist in its current
form, separate from the general calibration-gap problem.
- `HeavySetState` **(state-management, 0.78)** — the `>=8 setState(` calls-in-one-file
branch marks **every** setState call in that file as "problematic" purely on count,
regardless of what those calls actually do. This is a blunter rule than the
confidence number implies; a widget with many small, legitimately-local UI toggles
would trip it. Not "too confident for a subjective check" in the way the task's example
describes, but a rule-design gap that the 0.78 doesn't signal to a caller.
- Everything else in Bucket B sits in the 0.6–0.92 range, which is at least
*directionally* honest about being a judgment call (nothing here claims 95%+ certainty
for a genuinely subjective determination). No other individual finding stood out as
clearly overclaiming relative to how judgment-based its underlying question is.
- Worth noting in the opposite direction (not what the task asked to flag, but relevant
context): **LegacyNewKeywordUsage (0.7)** and **ModernClassModifiers (0.92)** /
**PatternMatching (0.75)** are syntactically near-exact already (`new` and
`sealed`/`final`/`base`/pattern-arrow syntax are essentially unambiguous keywords) —
0.7 for LegacyNewKeywordUsage in particular may be *under*-confident relative to how
mechanically reliable that specific regex already is.

## What was changed in this pass

**Nothing.** No analyzer file, scoring logic, or confidence value was edited. This
document is the only artifact produced.

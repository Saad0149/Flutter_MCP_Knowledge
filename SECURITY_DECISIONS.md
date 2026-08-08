# Security Decisions — deliberately not implemented

This document covers every Phase 1 audit finding where the "obvious" fix would remove or
restrict a feature the server exists to provide. These are documented decisions, not
oversights — each is re-confirmed below against what the Phase 1 audit (`AUDIT_FINDINGS.md`)
actually found, not assumed in advance.

Nothing in this document is implemented. If you want to act on one of the options below, that's
a follow-up decision, not something this pass makes for you.

---

## 1. Target project path is intentionally unrestricted

**The risk**: `review_project`/`analyze_*` accept an arbitrary `path` argument and scan whatever
directory it points to — anywhere on the host the server process can read.

**Why the obvious fix costs a feature**: The obvious fix — restrict scanning to a configured
allowlist of directories — breaks the core use case: "point this at any Flutter project and get
an analysis." Nearly every real invocation is a path the operator wasn't necessarily anticipating
when the server started (a freshly cloned repo, a project in a different location each session,
etc.). An allowlist would need constant reconfiguration to remain useful, defeating the point.

**Confirmed still applies**: Yes. Phase 1/2 did *not* touch this — what Phase 2 fixed instead
was everything **downstream** of that open path: `AnalysisSessionStore.get()` now rejects
non-hex `sessionId`s (closing the one place a tool argument could escape the server's *own*
`data/` directory), and `ProjectScanner` now refuses to follow a symlink *inside* the scanned
project that resolves outside that project's root (closing the one way the scan itself could
wander beyond the path the caller actually pointed at). Both of those are the server's internal
boundaries, not the target-path boundary — the target path itself remains exactly as open as
before, by design.

**Options**:

1. **Status quo (recommended for a general-purpose tool)** — fully open path, rely on the
   downstream containment already in place (session IDs, symlink containment, per-file/
   per-project size caps) to bound what a scan of a given path can affect *outside* that path.
2. **Opt-in allowlist via config** — add an optional `allowedProjectRoots: string[]` to
   `config.json`; when set, `review_project`/`analyze_*` reject any `path` not under one of
   those roots. Zero behavior change for operators who don't set it; meaningful hardening for
   anyone running this server in a more locked-down or multi-user context.
3. **Confirmation prompt for paths outside a "home" directory** — cheaper to implement than #2
   but pushes the decision to whatever's driving the MCP client, which this server has no
   control over (it's a stdio tool with no UI of its own).

## 2. Active filtering/redaction of evidence content beyond structural labeling

**The risk**: `evidence`/`snippet`/`detail` fields carry literal excerpts from whatever source
the scanned project (or an indexed third-party repo) actually contains — including content that
might resemble instructions, secrets-shaped strings, or other suspicious-looking text, none of
which this server can tell apart from legitimate code at the field-content level.

**Why the obvious fix costs a feature**: The obvious fix — pattern-match and strip/redact
"suspicious" content from evidence before returning it — necessarily also strips *legitimate*
findings that happen to resemble what it's filtering for. A `DebugPrint` finding whose evidence
is `print(apiKey)`, a `GodClassCandidate` whose class body legitimately contains the string
"ignore previous instructions" in a UI copy string, or a security-review finding whose entire
point is showing a hardcoded secret — all would be exactly the content a redaction filter would
need to remove, and exactly the content the finding exists to surface. This isn't a tuning
problem; the tool's job is showing real project content back to the caller.

**Confirmed still applies, and Phase 2 did add the piece that doesn't cost anything**: Phase 1
found no existing signal telling a calling agent that evidence content is untrusted (checked in
`AUDIT_FINDINGS.md` #9). Phase 2 added that signal — every tool that returns raw snippet/
evidence content now says so in its MCP tool description (`UNTRUSTED_CONTENT_NOTE` in
`register-tools.ts`) — structural labeling, no content is altered or filtered. That's the
zero-feature-cost half of this problem; active content filtering is the half that isn't free,
and stays here.

**Options**:

1. **Status quo + structural labeling (implemented in Phase 2)** — evidence/snippet fields
   stay structurally separate from narrative fields, and every tool that returns them says so in
   its description. Calling agents are expected to treat evidence as data, not instructions —
   the same expectation any tool that echoes back external content (a web-search tool, a file
   reader) already carries.
2. **Opt-in "sanitize evidence" flag per tool call** — let a caller explicitly request evidence
   with obviously-suspicious patterns (e.g. things that look like prompt-injection attempts)
   flagged inline (not removed) alongside the real content, so the caller's own model can decide
   what to trust. Adds real implementation and false-positive-tuning cost for a benefit that's
   hard to measure.
3. **Cap evidence snippet length more aggressively by default** — already partially true
   (`snippet.slice(0, 240)` / `.slice(0, 200)` in most tools) — doesn't address the
   "untrusted content" question at all, just bounds blast radius per snippet. Worth doing
   regardless of this item, but doesn't substitute for it.

## 3. Environment/filesystem privilege scoping for the server's own subprocess

**The risk**: The server (and the `dart` subprocess it spawns) runs with the same filesystem/
environment privileges as whatever user launched it — no sandboxing, no restricted PATH, no
reduced permission set.

**Why the obvious fix costs a feature**: The obvious fix — run with a minimal/restricted PATH
and filesystem view — directly conflicts with `src/parser/dart-sdk-locator.ts`, which exists
*specifically* because a restricted/incomplete PATH is the exact failure mode that silently
degraded analysis to heuristic-only mode for a long time before being diagnosed (see
`check_environment`'s own doc comment: *"this is exactly what silently degrades analysis to
heuristic mode even though `dart --version` looks fine"*). `locateDartExecutable()` deliberately
searches known install locations (Homebrew, `~/Documents/flutter`, fvm version directories, an
explicit `dartSdkPath` config override) precisely because it can't trust PATH alone. Sandboxing
the process's filesystem/env view would reintroduce that exact bug class from a different angle.

**Confirmed still applies**: Yes, unchanged by Phase 1/2 — this item is about the *server
process's own* privileges, which neither phase touched (Phase 2's fixes were all about
constraining what tool-facing *inputs* can reach, not the process's own ambient permissions).

**Options**:

1. **Status quo (recommended)** — full inherited privileges, rely on the input-side containment
   Phase 2 added (path traversal closed, symlink escape closed, subprocess calls already
   array-based with a hardcoded repo allowlist) to bound what an untrusted *input* can do, without
   constraining what the *trusted* Dart-detection logic can see.
2. **OS-level sandboxing at the deployment layer, not in-process** — if a given deployment wants
   process isolation (containers, macOS sandbox-exec, Linux namespaces), that's a decision for
   whoever launches the server, made with full knowledge of where their real Dart SDK lives —
   the server itself shouldn't guess at a policy that would break `dartSdkPath` config overrides
   for legitimate non-standard installs.
3. **Explicit `--sandbox` opt-in flag** — ship a stricter mode that trusts only `dartSdkPath`
   (no known-location/PATH fallback) for operators who'd rather configure it once than have
   auto-detection. Real feature work, not something to bolt on casually.

## 4. Diagnostic logging verbosity

**The risk**: `DartAnalyzerClient` logs the full `process.env.PATH` value at startup
(`dart-analyzer-client.ts:93-94`) — on a shared or logged system, that's the directory layout of
every tool on the host, which is more than most diagnostic logging exposes by default.

**Why the obvious fix costs a feature**: The obvious fix — redact or omit `PATH` from logs by
default — removes the exact signal that made the Dart-detection bug (see item 3) diagnosable in
the first place. That bug took multiple rounds to fix specifically *because* it was invisible:
`dart --version` looking fine locally while the actual spawned subprocess silently failed to
find Dart, with no visibility into why. The fix's own commit message and code comments treat
seeing the real inherited `PATH` as the debugging tool, not a mistake.

**Confirmed still applies, and Phase 1 found nothing worse**: Checked and confirmed nothing else
in the codebase logs more than this — no full `process.env` dump anywhere (`grep` for env
access → only `PATH`, `AUDIT_FINDINGS.md` #10), subprocess stdout/stderr in error messages is
already truncated to 500 chars, and no config file contents are logged wholesale. This remains
the one deliberately verbose spot, and it's scoped to exactly the one variable that matters for
the bug class it exists to catch.

**Options**:

1. **Status quo (recommended)** — log full `PATH` at startup; it's stderr-only (never mixed
   into the MCP stdio protocol channel), goes to whatever log destination the operator already
   controls, and is the tool's own debugging data about itself, not project or user secrets.
2. **Log PATH at `warning`/`error` level only, not unconditionally at `info`** — cuts log volume
   in the common case (Dart found fine) while keeping the diagnostic available whenever detection
   actually fails, which is when it's needed. Lowest-cost partial mitigation if log verbosity
   itself (not confidentiality) is the concern.
3. **Redact by default, add `--verbose-dart-detection` opt-in flag** — closest to "secure by
   default," but means the common failure report from a user ("dart isn't found") arrives
   without the one piece of information most likely to explain why, making the exact bug class
   this was built for harder to diagnose again.

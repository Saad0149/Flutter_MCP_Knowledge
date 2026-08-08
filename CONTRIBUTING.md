# Contributing

Thanks for taking the time to file a bug, request a feature, or send a PR.

**Found a security vulnerability?** Don't use a public issue — see [`SECURITY.md`](./SECURITY.md)
for the private reporting process instead.

## Reporting a bug

The single most useful thing you can include is enough for us to reproduce the finding you're
questioning, without having to guess. Please include:

- **Which tool** you called (e.g. `analyze_code_quality`, `find_intended_behavior`) and the
  arguments you passed (redact/replace anything sensitive in `path`, but keep its general shape
  — e.g. `lib/features/*` — since analyzer behavior sometimes depends on path structure).
- **The `sessionId`** from the response, if you have one (from `review_project` or any
  `analyze_*` call). This is the fastest way for us to look at exactly what you saw, since
  session reports are cached under `data/analysis-sessions/` for the lifetime of your local run.
- **Your Flutter project's rough shape and size**: feature-first or layer-first? roughly how
  many `.dart` files? monorepo or single package? Some findings (god-class thresholds, layer
  violation heuristics, complexity) are scale- and structure-sensitive, so "works fine on a
  200-file app, wrong on a 5,000-file one" is itself a useful data point.
- **Expected vs. actual**: what finding/count/score you expected, and what you actually got.
  For a "this number looks wrong" report specifically, the exact finding `code` (e.g.
  `LargeBuildMethod`, `CircularDependencies`) is more useful than the human-readable title, since
  codes are the stable identifier `explore_finding`/`explain_finding` key off of.
- **The output of `check_environment`**, if analysis looked degraded, heuristic-only, or
  otherwise "not quite right" — it rules out the two most common silent-failure causes (Dart not
  found, SQLite native binding mismatch) in one call.
- **Node version and OS** (`node --version`, and macOS/Linux/Windows + arch) if the issue looks
  environment-related rather than analysis-logic-related.

A minimal reproduction — a small fixture project (even a handful of files) that triggers the
finding — is the gold standard if you're able to put one together, but not required to file the
issue.

## Development setup

```bash
git clone https://github.com/Saad0149/Flutter_MCP_Knowledge.git
cd Flutter_MCP_Knowledge
npm install
npm run build
```

```bash
npm run test        # vitest
npm run typecheck   # tsc --noEmit
npm run lint         # eslint
npm run dev          # run the server directly against src/ via tsx
```

All four should be clean before opening a PR; CI (if configured) runs the same checks.

## Pull requests

- Keep PRs scoped to one change. If you're fixing a bug, a regression test that fails before your
  fix and passes after is the fastest way to get it merged.
- Match the existing code style (the project has `eslint`/`prettier` configured — `npm run
  lint:fix` and `npm run format` before committing).
- If you're changing analyzer logic (thresholds, scoring, new findings), explain the reasoning in
  the PR description — these are heuristics tuned against real projects, and "why" matters as
  much as "what" for future maintainers.

## Questions / not sure if it's a bug

Open an issue anyway — "is this expected?" is a completely reasonable thing to ask, and often
surfaces a documentation gap even when the behavior turns out to be correct.

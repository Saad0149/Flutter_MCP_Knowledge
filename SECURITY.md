# Security Policy

## Supported versions

This project is local-first tooling (an MCP server run on your own machine via stdio, no
network listener). Security fixes are made against the latest release on `main`; there are no
maintained older branches.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a suspected security vulnerability.

Instead, report it privately via **GitHub Security Advisories**:
[github.com/Saad0149/Flutter_MCP_Knowledge/security/advisories/new](../../security/advisories/new)
(use the repository's "Security" tab → "Report a vulnerability" if the link above doesn't
resolve for your fork).

Include, where possible:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal MCP tool call / input is ideal).
- The affected version/commit.

You should receive an acknowledgment within a few days. We'll work with you to understand and
confirm the issue, prepare a fix, and coordinate disclosure timing before any public write-up.

## Scope notes specific to this project

This server runs locally over stdio (no network listener) and is designed to scan **arbitrary,
potentially-untrusted third-party Flutter/Dart projects** on the operator's request — that's a
core feature, not a bug (see `SECURITY_DECISIONS.md` for the design tradeoffs this implies).
Reports that are most useful to us:

- Anything that lets a **scanned project's content** (not the operator's own input) affect
  behavior outside the scan itself — e.g. reading files outside the scanned project root,
  executing code, or causing resource exhaustion severe enough to be a practical DoS.
- Anything that lets a **tool argument** (not the scanned project) escape the server's own
  internal directories (`repos/`, `data/`) or reach a subprocess in an unintended way.
- Supply-chain concerns in the dependency tree.

Reports about the target project path itself being unrestricted, or about diagnostic logging
including the process `PATH`, are known, intentional design decisions — see
`SECURITY_DECISIONS.md` before filing those.

## Disclosure process

1. You report privately (above).
2. We confirm and assess severity.
3. We prepare a fix and, where meaningful, a regression test.
4. We coordinate a release and public advisory with you, crediting the report unless you prefer
   otherwise.

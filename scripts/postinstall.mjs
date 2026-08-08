#!/usr/bin/env node
// Resolves the Dart analyzer helper's own pub dependencies (parser/,
// specifically package:analyzer) right after `npm install`, at a
// predictable time when network access is most likely available — rather
// than leaving it to Dart's own automatic "pub get on first `dart run`"
// behavior, which is unpredictable (may not exist on older SDKs, may fail
// silently if there's no network at first-analysis time instead of at
// install time, and adds first-call latency while it resolves a fairly
// large dependency tree). See README "Analyzer package wasn't resolvable"
// and check_environment's dart.helperFailureReason field for the runtime
// diagnostic this complements.
//
// Never fails `npm install` over this: this is a best-effort convenience
// step, not a hard requirement — a user can always run `dart pub get`
// manually later (or set `dartSdkPath` in config.json once Dart is
// available), and the server falls back to heuristic-mode analysis in the
// meantime. Every exit path below is a normal return, never a non-zero
// process exit.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const parserDir = path.join(packageRoot, 'parser');

const PREFIX = '[flutter-knowledge-mcp postinstall]';

function candidateDartPaths() {
  const home = homedir();
  if (platform() === 'win32') {
    return [
      path.join(home, 'flutter', 'bin', 'dart.bat'),
      'C:\\flutter\\bin\\dart.bat',
      'C:\\src\\flutter\\bin\\dart.bat',
    ];
  }
  return [
    '/usr/local/bin/dart',
    '/opt/homebrew/bin/dart',
    path.join(home, 'Documents', 'flutter', 'bin', 'dart'),
    path.join(home, 'flutter', 'bin', 'dart'),
  ];
}

/**
 * Deliberately simpler than src/parser/dart-sdk-locator.ts's full detection
 * (PATH → known locations → fvm, with a `dartSdkPath` config override):
 * config.json isn't necessarily written yet at install time, and this only
 * needs to be a best-effort convenience, not authoritative — the
 * authoritative check is check_environment, run against the actual live
 * server process later, which uses the real detection logic.
 */
function findDart() {
  const pathProbe = spawnSync('dart', ['--version'], { stdio: 'ignore' });
  if (!pathProbe.error && pathProbe.status === 0) {
    return 'dart';
  }
  for (const candidate of candidateDartPaths()) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function main() {
  if (!existsSync(path.join(parserDir, 'pubspec.yaml'))) {
    // Nothing to resolve. Shouldn't happen in a published install (the
    // files field ships parser/pubspec.yaml), but don't ever fail a
    // contributor's `npm install` on a checkout state we don't expect.
    return;
  }

  const dartExec = findDart();
  if (!dartExec) {
    console.warn(
      `${PREFIX} Dart SDK not found on PATH or common install locations — skipping "dart pub get" for ` +
        'the analyzer helper. Not fatal: the server will still install and run, using heuristic-mode ' +
        'analysis (reduced confidence) until Dart is available. Install Dart, or set "dartSdkPath" in ' +
        'config.json if it\'s in a non-standard location, then run "dart pub get" inside this package\'s ' +
        'parser/ directory (or just reinstall). Call check_environment after starting the server to confirm.',
    );
    return;
  }

  console.log(`${PREFIX} Resolving analyzer helper dependencies via "${dartExec} pub get"...`);
  const result = spawnSync(dartExec, ['pub', 'get', '--offline'], { cwd: parserDir, stdio: 'pipe' });

  if (!result.error && result.status === 0) {
    console.log(`${PREFIX} Analyzer helper dependencies resolved successfully (from the shipped lockfile).`);
    return;
  }

  // --offline failed (no cached packages yet, e.g. truly first-ever install
  // on this machine) — retry with network, since that's the common case and
  // still fast/reliable when a pubspec.lock is present (verify + fetch, not
  // full re-resolution).
  const online = spawnSync(dartExec, ['pub', 'get'], { cwd: parserDir, stdio: 'inherit' });
  if (!online.error && online.status === 0) {
    console.log(`${PREFIX} Analyzer helper dependencies resolved successfully.`);
    return;
  }

  console.warn(
    `${PREFIX} "dart pub get" failed for the analyzer helper (see output above). Not fatal: the server ` +
      'will still install and run, using heuristic-mode analysis (reduced confidence) until this is ' +
      'resolved. Common cause: no network access at install time. Fix: run "dart pub get" manually inside ' +
      "this package's parser/ directory once you have network access, then call check_environment to confirm.",
  );
}

main();

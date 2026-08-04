import { constants as fsConstants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type DartLocateMethod =
  | 'config_override'
  | 'known_location'
  | 'path_lookup'
  | 'not_found';

export interface DartLocateAttempt {
  readonly method: DartLocateMethod;
  readonly candidate: string;
  readonly ok: boolean;
  readonly reason?: string;
}

export interface DartLocateResult {
  readonly execPath: string | null;
  readonly method: DartLocateMethod;
  readonly attempts: readonly DartLocateAttempt[];
}

export interface DartLocateOptions {
  /** From config.json `dartSdkPath`, checked first when present. */
  readonly configuredPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
}

function dartBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'dart.bat' : 'dart';
}

function knownLocations(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(home, 'flutter', 'bin', 'dart.bat'),
      path.join(localAppData, 'flutter', 'bin', 'dart.bat'),
      'C:\\flutter\\bin\\dart.bat',
      'C:\\src\\flutter\\bin\\dart.bat',
    ];
  }

  return [
    '/usr/local/bin/dart',
    '/opt/homebrew/bin/dart',
    path.join(home, 'Documents', 'flutter', 'bin', 'dart'),
    path.join(home, 'flutter', 'bin', 'dart'),
    '/snap/bin/dart',
  ];
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * fvm keeps every installed Dart/Flutter version under `<home>/fvm/versions/<version>`.
 * There's no "current" pointer we can trust across platforms, so we pick the
 * most-recently-modified version directory that actually contains a dart binary.
 */
async function findLatestFvmDart(
  platform: NodeJS.Platform,
  home: string,
): Promise<{ candidate: string; ok: boolean; reason?: string }> {
  const versionsDir = path.join(home, 'fvm', 'versions');
  const binName = dartBinaryName(platform);
  const globCandidate = path.join(versionsDir, '*', 'bin', binName);

  let entries;
  try {
    entries = await readdir(versionsDir, { withFileTypes: true });
  } catch {
    return { candidate: globCandidate, ok: false, reason: 'no fvm versions directory' };
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const withMtime = await Promise.all(
    dirs.map(async (d) => {
      try {
        const s = await stat(path.join(versionsDir, d.name));
        return { name: d.name, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withMtime
    .filter((v): v is { name: string; mtimeMs: number } => v !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const version of sorted) {
    const candidate = path.join(versionsDir, version.name, 'bin', binName);
    if (await fileExists(candidate)) {
      return { candidate, ok: true };
    }
  }

  return {
    candidate: globCandidate,
    ok: false,
    reason:
      dirs.length === 0
        ? 'fvm versions directory is empty'
        : 'no dart binary found under any fvm version',
  };
}

/**
 * Locates the Dart executable without solely relying on inherited PATH.
 * Tries, in order: explicit config override, common known install locations
 * (including fvm's most-recently-modified version), then PATH-based lookup
 * using the PATH value actually present in `env` at call time.
 */
export async function locateDartExecutable(
  options: DartLocateOptions = {},
): Promise<DartLocateResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const attempts: DartLocateAttempt[] = [];

  if (options.configuredPath) {
    const ok = await fileExists(options.configuredPath);
    attempts.push({
      method: 'config_override',
      candidate: options.configuredPath,
      ok,
      reason: ok ? undefined : 'configured dartSdkPath does not exist on disk',
    });
    if (ok) {
      return { execPath: options.configuredPath, method: 'config_override', attempts };
    }
  }

  for (const candidate of knownLocations(platform, home, env)) {
    const ok = await fileExists(candidate);
    attempts.push({ method: 'known_location', candidate, ok });
    if (ok) {
      return { execPath: candidate, method: 'known_location', attempts };
    }
  }

  const fvm = await findLatestFvmDart(platform, home);
  attempts.push({ method: 'known_location', candidate: fvm.candidate, ok: fvm.ok, reason: fvm.reason });
  if (fvm.ok) {
    return { execPath: fvm.candidate, method: 'known_location', attempts };
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const binName = dartBinaryName(platform);
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, binName);
    const ok = await fileExists(candidate);
    attempts.push({ method: 'path_lookup', candidate, ok });
    if (ok) {
      return { execPath: candidate, method: 'path_lookup', attempts };
    }
  }

  return { execPath: null, method: 'not_found', attempts };
}

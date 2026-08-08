import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface PrebuildPrecheckResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly target?: string;
}

export interface PrecheckOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly isMusl?: () => boolean;
  readonly existsSync?: (candidate: string) => boolean;
  readonly resolvePackageJson?: () => string;
}

const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin', 'win32']);
const SUPPORTED_ARCHS = new Set(['x64', 'arm64']);

/**
 * Pre-flight check for better-sqlite3's prebuilt native binary — run BEFORE
 * ever calling `require('better-sqlite3')`, so a missing/wrong-platform
 * binary is reported as a clean, structured error without ever attempting
 * to load native code at all.
 *
 * Why this specific check, and not a `process.versions.modules` /
 * NODE_MODULE_VERSION comparison: better-sqlite3 v13+ ships a single N-API
 * (ABI-stable across Node versions) prebuild per platform+arch — confirmed
 * directly from its own loader (node_modules/better-sqlite3/lib/binding.js):
 * it selects `prebuilds/<platform>-<arch>.node` (or `linuxmusl-<arch>.node`
 * under musl libc) with no per-Node-version ABI suffix anywhere in the
 * filename or package metadata, because N-API binaries don't need one —
 * that's the whole point of N-API. So there is no ABI version number to
 * read and compare against `process.versions.modules`; the classic
 * "compiled for NODE_MODULE_VERSION X, running on Y" failure mode this
 * dependency used to be able to hit (older, non-N-API versions) mostly
 * doesn't apply to this version at all. The one thing that *can* still be
 * wrong ahead of time — no prebuild shipped for this platform/arch — is
 * exactly what this function checks.
 *
 * That loader itself is not requireable from outside the package: Node's
 * package.json "exports" map only exposes the main entry point and
 * per-platform re-export shims, not internal files (verified: requiring
 * 'better-sqlite3/lib/binding.js' throws ERR_PACKAGE_PATH_NOT_EXPORTED). So
 * this replicates the same platform/arch/musl selection logic locally,
 * against only the package's public surface (its package.json path, plus
 * Node's own process.platform/process.arch/process.report) — deliberately
 * not the internal file, so it keeps working across better-sqlite3 updates
 * that don't change the public prebuilds/ layout.
 *
 * What this does NOT close: a corrupted binary, a Node runtime older than
 * the N-API version the addon requires, or a genuine memory-safety bug in
 * the native code can still crash the process in a way no JS-level check
 * (this one, or the try/catch around require() itself) can prevent — see
 * the security/robustness write-up for why that residual risk can't be
 * fully closed from pure JS. This check narrows the gap; it doesn't erase it.
 */
export function checkBetterSqlite3PrebuildAvailable(
  options: PrecheckOptions = {},
): PrebuildPrecheckResult {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const isMusl = options.isMusl ?? defaultIsMusl;
  const existsSyncFn = options.existsSync ?? existsSync;
  const resolvePackageJson = options.resolvePackageJson ?? defaultResolvePackageJson;

  if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHS.has(arch)) {
    return {
      ok: false,
      reason: `better-sqlite3 ships no prebuilt binary for platform "${platform}" / arch "${arch}".`,
    };
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = resolvePackageJson();
  } catch {
    // better-sqlite3 itself can't be resolved at all (not installed, or a
    // deeper module-resolution problem) — that's a different failure than
    // "wrong binary for this platform". Let the normal require() path
    // surface it with Node's own clear MODULE_NOT_FOUND error instead of
    // this check trying to explain a missing dependency.
    return { ok: true };
  }

  const packageRoot = path.dirname(packageJsonPath);
  const target = `${platform === 'linux' && isMusl() ? 'linuxmusl' : platform}-${arch}`;
  const prebuildPath = path.join(packageRoot, 'prebuilds', `${target}.node`);

  if (!existsSyncFn(prebuildPath)) {
    return {
      ok: false,
      reason: `No prebuilt better-sqlite3 binary found for "${target}" (expected at ${prebuildPath}).`,
      target,
    };
  }

  return { ok: true, target };
}

function defaultIsMusl(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    const report = process.report?.getReport?.() as
      | { readonly header?: { readonly glibcVersionRuntime?: string } }
      | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function defaultResolvePackageJson(): string {
  const req = createRequire(import.meta.url);
  return req.resolve('better-sqlite3/package.json');
}

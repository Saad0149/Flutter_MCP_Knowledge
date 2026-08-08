import { describe, expect, it, vi } from 'vitest';
import { checkBetterSqlite3PrebuildAvailable } from '../../../src/store/native-binding-precheck.js';

describe('checkBetterSqlite3PrebuildAvailable', () => {
  it('reports ok:true when a matching prebuild file exists on disk', () => {
    const result = checkBetterSqlite3PrebuildAvailable({
      platform: 'darwin',
      arch: 'arm64',
      isMusl: () => false,
      existsSync: vi.fn().mockReturnValue(true),
      resolvePackageJson: () => '/fake/node_modules/better-sqlite3/package.json',
    });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('darwin-arm64');
  });

  it('reports ok:false with a clear reason when no prebuild exists for this platform/arch', () => {
    const existsSync = vi.fn().mockReturnValue(false);
    const result = checkBetterSqlite3PrebuildAvailable({
      platform: 'darwin',
      arch: 'arm64',
      isMusl: () => false,
      existsSync,
      resolvePackageJson: () => '/fake/node_modules/better-sqlite3/package.json',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('darwin-arm64');
    expect(existsSync).toHaveBeenCalledWith(
      '/fake/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
    );
  });

  it('selects the linuxmusl target when running under musl libc (e.g. Alpine)', () => {
    const existsSync = vi.fn().mockReturnValue(true);
    const result = checkBetterSqlite3PrebuildAvailable({
      platform: 'linux',
      arch: 'x64',
      isMusl: () => true,
      existsSync,
      resolvePackageJson: () => '/fake/node_modules/better-sqlite3/package.json',
    });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('linuxmusl-x64');
    expect(existsSync).toHaveBeenCalledWith(
      '/fake/node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node',
    );
  });

  it('reports ok:false for a platform/arch better-sqlite3 ships no prebuild for at all', () => {
    const result = checkBetterSqlite3PrebuildAvailable({
      // Cast: intentionally an unsupported platform to exercise the guard.
      platform: 'sunos' as NodeJS.Platform,
      arch: 'x64',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/sunos/);
  });

  it('defers to the normal require() path (ok:true) when better-sqlite3 cannot be resolved at all', () => {
    // A missing dependency is a different failure than "wrong binary for
    // this platform" — this check should stay out of the way and let
    // require() surface Node's own clear MODULE_NOT_FOUND error instead.
    const result = checkBetterSqlite3PrebuildAvailable({
      platform: 'darwin',
      arch: 'arm64',
      resolvePackageJson: () => {
        throw new Error("Cannot find module 'better-sqlite3/package.json'");
      },
    });

    expect(result.ok).toBe(true);
  });

  it('against the real installed package on this machine: reports ok:true (sanity check the real prebuild is where this logic expects)', () => {
    const result = checkBetterSqlite3PrebuildAvailable();
    expect(result.ok).toBe(true);
  });
});

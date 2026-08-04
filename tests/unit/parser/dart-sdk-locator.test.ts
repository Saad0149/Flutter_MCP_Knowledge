import { chmod, mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateDartExecutable } from '../../../src/parser/dart-sdk-locator.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';

async function makeFakeDart(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '#!/bin/sh\necho fake dart\n', 'utf8');
  await chmod(filePath, 0o755);
}

describe('locateDartExecutable', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('uses the config override when it exists, even if PATH also has a dart', async () => {
    tempDir = await createTempDir('dart-locator-config-');
    const configured = path.join(tempDir, 'custom', 'dart');
    await makeFakeDart(configured);

    const pathDir = path.join(tempDir, 'path-bin');
    await makeFakeDart(path.join(pathDir, 'dart'));

    const result = await locateDartExecutable({
      configuredPath: configured,
      env: { PATH: pathDir },
      platform: 'darwin',
      homedir: path.join(tempDir, 'home'),
    });

    expect(result.method).toBe('config_override');
    expect(result.execPath).toBe(configured);
  });

  it('falls through to auto-detection when the configured override does not exist', async () => {
    tempDir = await createTempDir('dart-locator-bad-config-');
    const home = path.join(tempDir, 'home');
    const pathDir = path.join(tempDir, 'path-bin');
    await makeFakeDart(path.join(pathDir, 'dart'));

    const result = await locateDartExecutable({
      configuredPath: path.join(tempDir, 'does-not-exist', 'dart'),
      env: { PATH: pathDir },
      platform: 'darwin',
      homedir: home,
    });

    expect(result.method).toBe('path_lookup');
    expect(result.execPath).toBe(path.join(pathDir, 'dart'));
    expect(result.attempts.some((a) => a.method === 'config_override' && !a.ok)).toBe(true);
  });

  it('finds dart at a known install location (Documents/flutter/bin) when PATH has nothing', async () => {
    tempDir = await createTempDir('dart-locator-known-');
    const home = path.join(tempDir, 'home');
    const dartPath = path.join(home, 'Documents', 'flutter', 'bin', 'dart');
    await makeFakeDart(dartPath);

    const result = await locateDartExecutable({
      env: { PATH: '/usr/bin:/bin' },
      platform: 'darwin',
      homedir: home,
    });

    expect(result.method).toBe('known_location');
    expect(result.execPath).toBe(dartPath);
  });

  it('picks the most-recently-modified fvm version when multiple are installed', async () => {
    tempDir = await createTempDir('dart-locator-fvm-');
    const home = path.join(tempDir, 'home');

    const older = path.join(home, 'fvm', 'versions', '3.0.0', 'bin', 'dart');
    const newer = path.join(home, 'fvm', 'versions', '3.5.0', 'bin', 'dart');
    await makeFakeDart(older);
    await makeFakeDart(newer);

    const now = new Date();
    await utimes(older, now, new Date(now.getTime() - 60_000));
    await utimes(newer, now, now);

    const result = await locateDartExecutable({
      env: { PATH: '/usr/bin:/bin' },
      platform: 'darwin',
      homedir: home,
    });

    expect(result.method).toBe('known_location');
    expect(result.execPath).toBe(newer);
  });

  it('falls back to PATH lookup using the provided env.PATH as the last resort', async () => {
    tempDir = await createTempDir('dart-locator-path-');
    const home = path.join(tempDir, 'home');
    const pathDir = path.join(tempDir, 'custom-path-bin');
    await makeFakeDart(path.join(pathDir, 'dart'));

    const result = await locateDartExecutable({
      env: { PATH: `/usr/bin:${pathDir}:/bin` },
      platform: 'darwin',
      homedir: home,
    });

    expect(result.method).toBe('path_lookup');
    expect(result.execPath).toBe(path.join(pathDir, 'dart'));
  });

  it('reports not_found with a full attempt trail when nothing matches anywhere', async () => {
    tempDir = await createTempDir('dart-locator-none-');
    const home = path.join(tempDir, 'home');

    const result = await locateDartExecutable({
      env: { PATH: '/usr/bin:/bin' },
      platform: 'darwin',
      homedir: home,
    });

    expect(result.method).toBe('not_found');
    expect(result.execPath).toBeNull();
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.attempts.every((a) => !a.ok)).toBe(true);
  });

  it('checks the win32 known locations including %USERPROFILE%\\flutter\\bin\\dart.bat', async () => {
    tempDir = await createTempDir('dart-locator-win-');
    const home = path.join(tempDir, 'home');
    const dartBat = path.join(home, 'flutter', 'bin', 'dart.bat');
    await makeFakeDart(dartBat);

    const result = await locateDartExecutable({
      env: { PATH: 'C:\\Windows\\System32' },
      platform: 'win32',
      homedir: home,
    });

    expect(result.method).toBe('known_location');
    expect(result.execPath).toBe(dartBat);
  });
});

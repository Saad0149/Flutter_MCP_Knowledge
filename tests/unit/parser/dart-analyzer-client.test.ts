import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

function fakeConfig(dartSdkPath?: string): AppConfig {
  return {
    repositoriesRoot: './repos',
    indexPath: './data/knowledge.sqlite',
    indexOnUpdate: true,
    dartSdkPath,
  };
}

/** A fake `dart` that handles --version normally but prints garbage (not JSON) to
 * stdout with exit 0 for `run` — reproducing the "helper exits 0 but stdout isn't
 * JSON" bug where V8's JSON.parse error truncates to ~10 chars of context. */
async function makeFakeDartWithGarbageOutput(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "Fake Dart SDK version: 3.0.0"',
      '  exit 0',
      'fi',
      'if [ "$1" = "run" ]; then',
      '  echo "Running bunk output that is definitely not JSON and quite a bit longer than ten characters so we can confirm truncation-vs-full-capture behavior in the diagnostic message"',
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n'),
    'utf8',
  );
  await chmod(filePath, 0o755);
}

/** A fake `dart` that fails the helper run with a non-zero exit and stderr text. */
async function makeFakeDartWithNonZeroExit(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "Fake Dart SDK version: 3.0.0"',
      '  exit 0',
      'fi',
      'if [ "$1" = "run" ]; then',
      '  echo "some partial stdout" ',
      '  echo "Error: something in the helper genuinely crashed" >&2',
      '  exit 1',
      'fi',
      'exit 1',
    ].join('\n'),
    'utf8',
  );
  await chmod(filePath, 0o755);
}

/**
 * Reproduces the real bug found in production: some Dart SDK versions print
 * "Running build hooks..." (native-assets feature) straight to stdout ahead
 * of a script's own output, concatenated with NO separator at all — not even
 * a newline — directly butting up against our JSON. Uses `printf` (not
 * `echo`) specifically to avoid emitting a trailing newline, matching what
 * was observed in the wild.
 */
async function makeFakeDartWithHooksPreambleNoSeparator(
  filePath: string,
  markerLine: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  // Single-quote the payload for the shell (escaping any embedded single
  // quotes) since the JSON payload itself contains double quotes that would
  // otherwise break a double-quoted `echo "..."`.
  const shellSingleQuoted = `'${markerLine.replace(/'/g, `'\\''`)}'`;
  await writeFile(
    filePath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "Fake Dart SDK version: 3.0.0"',
      '  exit 0',
      'fi',
      'if [ "$1" = "run" ]; then',
      '  printf "Running build hooks...Running build hooks..."',
      `  echo ${shellSingleQuoted}`,
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n'),
    'utf8',
  );
  await chmod(filePath, 0o755);
}

describe('DartAnalyzerClient diagnostic error surfacing', () => {
  let tempDir: string | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
    if (projectDir) {
      await removeTempDir(projectDir);
      projectDir = undefined;
    }
  });

  it('surfaces the full raw stdout when the helper exits 0 but prints non-JSON', async () => {
    tempDir = await createTempDir('dart-client-garbage-');
    const fakeDart = path.join(tempDir, 'dart');
    await makeFakeDartWithGarbageOutput(fakeDart);

    projectDir = await createTempDir('dart-client-project-');
    await writeFile(path.join(projectDir, 'probe.dart'), 'class Foo {}\n', 'utf8');

    const client = new DartAnalyzerClient(fakeConfig(fakeDart), new SilentLogger());
    const result = await client.analyzeFiles(projectDir, ['probe.dart']);

    expect(result.available).toBe(false);
    expect(result.warning).toContain('not valid JSON');
    // The full offending text must be present verbatim, not just V8's ~10-char preview.
    expect(result.warning).toContain('Running bunk output that is definitely not JSON');
    expect(result.warning).toContain('truncation-vs-full-capture');
  });

  it('truncates very long stdout in the diagnostic rather than dumping unbounded text', async () => {
    tempDir = await createTempDir('dart-client-huge-');
    const fakeDart = path.join(tempDir, 'dart');
    await mkdir(path.dirname(fakeDart), { recursive: true });
    const hugeLine = 'X'.repeat(2000);
    await writeFile(
      fakeDart,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "Fake Dart SDK version: 3.0.0"',
        '  exit 0',
        'fi',
        'if [ "$1" = "run" ]; then',
        `  echo "${hugeLine}"`,
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeDart, 0o755);

    projectDir = await createTempDir('dart-client-project2-');
    await writeFile(path.join(projectDir, 'probe.dart'), 'class Foo {}\n', 'utf8');

    const client = new DartAnalyzerClient(fakeConfig(fakeDart), new SilentLogger());
    const result = await client.analyzeFiles(projectDir, ['probe.dart']);

    expect(result.available).toBe(false);
    expect(result.warning).toContain('truncated');
    expect(result.warning!.length).toBeLessThan(hugeLine.length);
  });

  it('includes stderr text when the helper exits non-zero', async () => {
    tempDir = await createTempDir('dart-client-nonzero-');
    const fakeDart = path.join(tempDir, 'dart');
    await makeFakeDartWithNonZeroExit(fakeDart);

    projectDir = await createTempDir('dart-client-project3-');
    await writeFile(path.join(projectDir, 'probe.dart'), 'class Foo {}\n', 'utf8');

    const client = new DartAnalyzerClient(fakeConfig(fakeDart), new SilentLogger());
    const result = await client.analyzeFiles(projectDir, ['probe.dart']);

    expect(result.available).toBe(false);
    expect(result.warning).toContain('exited with code 1');
    expect(result.warning).toContain('genuinely crashed');
  });

  it('parses correctly through Dart preamble noise directly butting up against the JSON (real bug regression)', async () => {
    tempDir = await createTempDir('dart-client-hooks-preamble-');
    const fakeDart = path.join(tempDir, 'dart');
    const markerAndJson =
      '@@FLUTTER_KNOWLEDGE_JSON@@\n' +
      JSON.stringify({
        files: [{ path: 'probe.dart', symbols: [{ name: 'Foo', kind: 'class', line: 1 }] }],
      });
    await makeFakeDartWithHooksPreambleNoSeparator(fakeDart, markerAndJson);

    projectDir = await createTempDir('dart-client-project4-');
    await writeFile(path.join(projectDir, 'probe.dart'), 'class Foo {}\n', 'utf8');

    const client = new DartAnalyzerClient(fakeConfig(fakeDart), new SilentLogger());
    const result = await client.analyzeFiles(projectDir, ['probe.dart']);

    expect(result.available).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.files).toEqual([
      { path: 'probe.dart', symbols: [{ name: 'Foo', kind: 'class', line: 1 }] },
    ]);
  });

  it('verifyHelperEndToEnd surfaces the same diagnostic for a broken helper', async () => {
    tempDir = await createTempDir('dart-client-verify-');
    const fakeDart = path.join(tempDir, 'dart');
    await makeFakeDartWithGarbageOutput(fakeDart);

    const client = new DartAnalyzerClient(fakeConfig(fakeDart), new SilentLogger());
    const result = await client.verifyHelperEndToEnd();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Running bunk output');
  });
});

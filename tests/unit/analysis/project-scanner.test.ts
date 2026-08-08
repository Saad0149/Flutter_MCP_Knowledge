import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AstAdapter } from '../../../src/analysis/ast/ast-adapter.js';
import { ProjectScanner } from '../../../src/analysis/project-scanner.js';
import { HeuristicSymbolExtractor } from '../../../src/parser/heuristic-extractor.js';
import type { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

function unavailableDartClient(): DartAnalyzerClient {
  return {
    isAvailable: async () => false,
    analyzeFiles: async () => ({ available: false, files: [], warning: 'unavailable' }),
    getHelperPath: () => '',
    toInsertSymbols: () => [],
  } as unknown as DartAnalyzerClient;
}

function buildScanner(): ProjectScanner {
  const ast = new AstAdapter(unavailableDartClient(), new HeuristicSymbolExtractor(), new SilentLogger());
  return new ProjectScanner(ast, new SilentLogger());
}

/**
 * SECURITY regression: ProjectScanner walks arbitrary, potentially-untrusted
 * target projects. A symlink inside the project could previously be
 * followed straight through to anywhere else on the host — a symlinked
 * file leaking another file's content into the scan, or a symlinked
 * directory pulling in an entire unrelated directory tree. This confirms
 * both are now blocked, while a normal (non-symlinked) project still scans
 * exactly as before.
 */
describe('ProjectScanner — symlink containment', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  async function setupProject(): Promise<{ projectPath: string; secretPath: string; secretDir: string }> {
    tempDir = await createTempDir('symlink-scan-');
    const projectPath = path.join(tempDir, 'project');
    const outside = path.join(tempDir, 'outside-the-project');
    await mkdir(path.join(projectPath, 'lib'), { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(
      path.join(projectPath, 'pubspec.yaml'),
      'name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n',
      'utf8',
    );
    await writeFile(
      path.join(projectPath, 'lib', 'real.dart'),
      'class RealWidget { void run() {} }\n',
      'utf8',
    );

    const secretPath = path.join(outside, 'secret.dart');
    await writeFile(secretPath, "class LeakedSecret { String token = 'sk-not-a-real-secret'; }\n", 'utf8');

    const secretDir = path.join(outside, 'other_project_lib');
    await mkdir(secretDir, { recursive: true });
    await writeFile(
      path.join(secretDir, 'other_file.dart'),
      'class ShouldNotAppear { void run() {} }\n',
      'utf8',
    );

    return { projectPath, secretPath, secretDir };
  }

  it('does not follow a symlinked FILE that resolves outside the project root', async () => {
    const { projectPath, secretPath } = await setupProject();
    await symlink(secretPath, path.join(projectPath, 'lib', 'leaked.dart'));

    const scanner = buildScanner();
    const snapshot = await scanner.scan(projectPath);

    const leakedContent = snapshot.dartFiles.some((f) => f.content.includes('LeakedSecret'));
    expect(leakedContent).toBe(false);
    // The legitimate file is still scanned normally.
    expect(snapshot.dartFiles.some((f) => f.relativePath === 'lib/real.dart')).toBe(true);
  });

  it('does not recurse into a symlinked DIRECTORY that resolves outside the project root', async () => {
    const { projectPath, secretDir } = await setupProject();
    await symlink(secretDir, path.join(projectPath, 'lib', 'linked_dir'), 'dir');

    const scanner = buildScanner();
    const snapshot = await scanner.scan(projectPath);

    const escapedContent = snapshot.dartFiles.some((f) => f.content.includes('ShouldNotAppear'));
    expect(escapedContent).toBe(false);
    expect(snapshot.dartFiles.some((f) => f.relativePath === 'lib/real.dart')).toBe(true);
  });

  it('scans a project with no symlinks exactly as before', async () => {
    const { projectPath } = await setupProject();
    const scanner = buildScanner();
    const snapshot = await scanner.scan(projectPath);

    expect(snapshot.dartFiles.map((f) => f.relativePath)).toEqual(['lib/real.dart']);
  });
});

describe('ProjectScanner — resource-exhaustion caps', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('skips a single Dart file larger than the size safety cap instead of loading it fully', async () => {
    tempDir = await createTempDir('scanner-size-cap-');
    const projectPath = path.join(tempDir, 'project');
    await mkdir(path.join(projectPath, 'lib'), { recursive: true });
    await writeFile(
      path.join(projectPath, 'pubspec.yaml'),
      'name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n',
      'utf8',
    );
    await writeFile(path.join(projectPath, 'lib', 'normal.dart'), 'class Normal {}\n', 'utf8');

    // 6MB of content — over the 5MB cap.
    const huge = `class Huge {\n${'  // pad\n'.repeat(900_000)}}\n`;
    await writeFile(path.join(projectPath, 'lib', 'huge.dart'), huge, 'utf8');

    const scanner = buildScanner();
    const snapshot = await scanner.scan(projectPath);

    expect(snapshot.dartFiles.some((f) => f.relativePath === 'lib/normal.dart')).toBe(true);
    expect(snapshot.dartFiles.some((f) => f.relativePath === 'lib/huge.dart')).toBe(false);
  });
});

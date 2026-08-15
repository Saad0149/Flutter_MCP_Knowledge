import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { inject, injectable } from 'tsyringe';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { AppError } from '../utils/errors.js';
import { AstAdapter } from './ast/ast-adapter.js';
import type { DartFileInfo, ProjectSnapshot } from './types.js';

const IGNORE = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.dart_tool/**',
  '**/build/**',
  '**/.idea/**',
  '**/ios/**',
  '**/android/**',
  '**/macos/**',
  '**/windows/**',
  '**/linux/**',
  '**/web/**',
] as const;

const IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]\s*;/gm;

/**
 * Per-file cap: a legitimate hand-written Dart file is essentially always a
 * few KB to low hundreds of KB. 5MB is generous headroom while still
 * bounding memory use against a pathological/adversarial single file.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Total matched-file cap. flutter/flutter itself (the largest real Flutter
 * codebase in this project's own knowledge base) has on the order of a few
 * thousand .dart files — 20,000 leaves generous headroom for any real
 * monorepo while bounding the worst case (e.g. a directory-symlink loop, or
 * an adversarially bloated project) from scanning without limit.
 */
const MAX_DART_FILES = 20_000;

@injectable()
export class ProjectScanner {
  constructor(
    @inject(TYPES.AstAdapter) private readonly astAdapter: AstAdapter,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async scan(projectPathInput: string): Promise<ProjectSnapshot> {
    const projectPath = path.resolve(projectPathInput);

    try {
      await access(projectPath);
    } catch {
      throw new AppError('ProjectNotFound', `Project path does not exist: ${projectPath}`);
    }

    const pubspecPath = path.join(projectPath, 'pubspec.yaml');
    let pubspecRaw: string | null = null;
    let hasPubspec = false;
    try {
      pubspecRaw = await readFile(pubspecPath, 'utf8');
      hasPubspec = true;
    } catch {
      // optional
    }

    const packageName = pubspecRaw ? extractYamlScalar(pubspecRaw, 'name') : null;
    const dependencies = pubspecRaw ? extractDependencyKeys(pubspecRaw, 'dependencies') : [];
    const devDependencies = pubspecRaw
      ? extractDependencyKeys(pubspecRaw, 'dev_dependencies')
      : [];
    const isFlutterProject =
      Boolean(pubspecRaw && /flutter\s*:/.test(pubspecRaw)) || dependencies.includes('flutter');

    let hasAnalysisOptions = false;
    try {
      await access(path.join(projectPath, 'analysis_options.yaml'));
      hasAnalysisOptions = true;
    } catch {
      // optional
    }

    const libExists = await pathExists(path.join(projectPath, 'lib'));
    const testExists = await pathExists(path.join(projectPath, 'test'));
    const topLevelDirs = await listDirs(projectPath);
    const libDirs = libExists ? await listDirs(path.join(projectPath, 'lib')) : [];

    // SECURITY: followSymbolicLinks:false stops fast-glob from recursing into
    // a symlinked directory inside the scanned project (which could point
    // anywhere on the host, e.g. the user's home directory — turning one
    // symlink into an unbounded scan of unrelated files). The realpath
    // containment check below additionally catches a symlinked *file*
    // (which followSymbolicLinks:false alone does not exclude from the
    // match list) pointing outside the project root, e.g.
    // lib/x.dart -> ~/.ssh/id_rsa. This mirrors the followSymbolicLinks:false
    // already used for the server's own repo scans in filesystem-search.ts
    // and repository-indexer.ts — this was the one scan surface missing it,
    // and it's the highest-risk one (arbitrary third-party projects).
    let dartPaths = await fg(['**/*.dart'], {
      cwd: projectPath,
      absolute: false,
      onlyFiles: true,
      ignore: [...IGNORE],
      followSymbolicLinks: false,
    });

    if (dartPaths.length > MAX_DART_FILES) {
      this.logger.warning('Project scan matched more Dart files than the safety cap; truncating', {
        projectPath,
        matched: dartPaths.length,
        cap: MAX_DART_FILES,
      });
      dartPaths = dartPaths.slice(0, MAX_DART_FILES);
    }

    const projectRealRoot = await realpath(projectPath);
    const dartFiles: DartFileInfo[] = [];
    const importEdges: { from: string; to: string }[] = [];

    for (const relativePath of dartPaths) {
      const absolutePath = path.join(projectPath, relativePath);

      let resolvedReal: string;
      try {
        resolvedReal = await realpath(absolutePath);
      } catch {
        continue; // broken symlink or vanished mid-scan; skip silently
      }

      if (resolvedReal !== projectRealRoot && !resolvedReal.startsWith(projectRealRoot + path.sep)) {
        this.logger.warning('Skipping file whose symlink resolves outside the project root', {
          projectPath,
          relativePath,
        });
        continue;
      }

      const stats = await stat(resolvedReal);
      if (stats.size > MAX_FILE_BYTES) {
        this.logger.warning('Skipping Dart file exceeding the size safety cap', {
          relativePath,
          bytes: stats.size,
          cap: MAX_FILE_BYTES,
        });
        continue;
      }

      const content = await readFile(absolutePath, 'utf8');
      const normalized = relativePath.replaceAll('\\', '/');
      const imports = extractImports(content);
      const packageImports = imports.filter((i) => i.startsWith('package:'));
      const relativeImports = imports.filter((i) => i.startsWith('./') || i.startsWith('../'));

      dartFiles.push({
        relativePath: normalized,
        absolutePath,
        lineCount: content.split(/\r?\n/).length,
        content,
        imports,
        packageImports,
        relativeImports,
        astMetrics: null,
      });

      for (const imp of relativeImports) {
        const resolved = resolveDartImport(normalized, imp);
        if (resolved) {
          importEdges.push({ from: normalized, to: resolved });
        }
      }

      if (packageName) {
        for (const imp of packageImports) {
          const prefix = `package:${packageName}/`;
          if (imp.startsWith(prefix)) {
            const rest = imp.slice(prefix.length);
            importEdges.push({ from: normalized, to: `lib/${rest}` });
          }
        }
      }
    }

    const { symbols, astMeta, fileMetrics } = await this.astAdapter.extractSymbols(
      projectPath,
      dartFiles,
    );
    const dartFilesWithMetrics =
      fileMetrics.size === 0
        ? dartFiles
        : dartFiles.map((f) => {
            const metrics = fileMetrics.get(f.relativePath);
            return metrics ? { ...f, astMetrics: metrics } : f;
          });

    return {
      projectPath,
      hasPubspec,
      pubspecRaw,
      packageName,
      dependencies,
      devDependencies,
      isFlutterProject,
      hasAnalysisOptions,
      libExists,
      testExists,
      topLevelDirs,
      libDirs,
      dartFiles: dartFilesWithMetrics,
      symbols,
      importEdges,
      astMeta,
    };
  }
}

function extractImports(content: string): string[] {
  const results: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    if (match[1]) {
      results.push(match[1]);
    }
  }
  return results;
}

function resolveDartImport(fromFile: string, importPath: string): string | null {
  const fromDir = path.posix.dirname(fromFile);
  let resolved = path.posix.normalize(path.posix.join(fromDir, importPath));
  if (!resolved.endsWith('.dart')) {
    resolved = `${resolved}.dart`;
  }
  if (resolved.startsWith('../')) {
    return null;
  }
  return resolved.replace(/^\.\//, '');
}

function extractYamlScalar(raw: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*([^#\\n]+)`, 'm').exec(raw);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null;
}

function extractDependencyKeys(raw: string, section: string): string[] {
  const lines = raw.split(/\r?\n/);
  const keys: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (/^\S/.test(line) && line.trim().endsWith(':')) {
      inSection = line.trim() === `${section}:`;
      continue;
    }
    if (!inSection) {
      continue;
    }
    if (/^\s{2}[A-Za-z0-9_]/.test(line)) {
      const key = line.trim().split(':')[0]?.trim();
      if (key && key !== 'sdk') {
        keys.push(key);
      }
    }
  }
  return keys;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { inject, injectable } from 'tsyringe';
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

@injectable()
export class ProjectScanner {
  constructor(@inject(TYPES.AstAdapter) private readonly astAdapter: AstAdapter) {}

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

    const dartPaths = await fg(['**/*.dart'], {
      cwd: projectPath,
      absolute: false,
      onlyFiles: true,
      ignore: [...IGNORE],
    });

    const dartFiles: DartFileInfo[] = [];
    const importEdges: { from: string; to: string }[] = [];

    for (const relativePath of dartPaths) {
      const absolutePath = path.join(projectPath, relativePath);
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

    const { symbols, astMeta } = await this.astAdapter.extractSymbols(projectPath, dartFiles);

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
      dartFiles,
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

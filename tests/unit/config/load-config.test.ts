import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load-config.js';
import { ConfigSchema } from '../../../src/config/schema.js';
import { AppError } from '../../../src/utils/errors.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';

describe('ConfigSchema', () => {
  it('applies default repositoriesRoot and index settings', () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.repositoriesRoot).toBe('./repos');
    expect(parsed.indexPath).toBe('./data/knowledge.sqlite');
    expect(parsed.indexOnUpdate).toBe(true);
  });

  it('rejects empty repositoriesRoot', () => {
    expect(() => ConfigSchema.parse({ repositoriesRoot: '' })).toThrow();
  });
});

describe('loadConfig', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it('loads and resolves relative paths against config directory', async () => {
    tempDir = await createTempDir('config-');
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify(
        {
          repositoriesRoot: './data/repos',
          indexPath: './data/knowledge.sqlite',
          indexOnUpdate: false,
        },
        null,
        2,
      ),
      'utf8',
    );

    const config = await loadConfig(configPath);
    expect(config.repositoriesRoot).toBe(path.join(tempDir, 'data', 'repos'));
    expect(config.indexPath).toBe(path.join(tempDir, 'data', 'knowledge.sqlite'));
    expect(config.indexOnUpdate).toBe(false);
  });

  it('keeps absolute repositoriesRoot unchanged', async () => {
    tempDir = await createTempDir('config-abs-');
    const absoluteRoot = path.join(tempDir, 'absolute-repos');
    await mkdir(absoluteRoot, { recursive: true });

    const configPath = path.join(tempDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ repositoriesRoot: absoluteRoot }, null, 2),
      'utf8',
    );

    const config = await loadConfig(configPath);
    expect(config.repositoriesRoot).toBe(absoluteRoot);
  });

  it('throws ConfigError when file is missing', async () => {
    await expect(loadConfig('/tmp/does-not-exist-flutter-knowledge.json')).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === 'ConfigError',
    );
  });

  it('throws ConfigError for invalid JSON', async () => {
    tempDir = await createTempDir('config-bad-');
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, '{not-json', 'utf8');

    await expect(loadConfig(configPath)).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === 'ConfigError',
    );
  });
});

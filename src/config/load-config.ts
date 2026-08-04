import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../utils/errors.js';
import { ConfigSchema, type AppConfig } from './schema.js';

const DEFAULT_CONFIG_FILENAME = 'config.json';

/**
 * Loads and validates application configuration from a JSON file.
 * Paths are resolved relative to the config file's directory (or cwd when omitted).
 */
export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const resolvedPath = path.resolve(configPath ?? DEFAULT_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    throw new AppError(
      'ConfigError',
      `Failed to read config file at ${resolvedPath}`,
      error instanceof Error ? error.message : error,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError(
      'ConfigError',
      `Invalid JSON in config file at ${resolvedPath}`,
      error instanceof Error ? error.message : error,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError('ConfigError', 'Configuration validation failed', result.error.flatten());
  }

  const configDir = path.dirname(resolvedPath);

  return {
    repositoriesRoot: resolvePath(configDir, result.data.repositoriesRoot),
    indexPath: resolvePath(configDir, result.data.indexPath),
    indexOnUpdate: result.data.indexOnUpdate,
    dartSdkPath:
      result.data.dartSdkPath !== undefined
        ? resolvePath(configDir, result.data.dartSdkPath)
        : undefined,
  };
}

function resolvePath(configDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

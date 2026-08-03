#!/usr/bin/env node
import 'reflect-metadata';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config/load-config.js';
import { createMcpServer } from './server/create-server.js';
import { createContainer } from './server/container.js';
import { AppError } from './utils/errors.js';
import { StructuredLogger } from './utils/logger.js';

async function main(): Promise<void> {
  const logger = new StructuredLogger();
  const configPath = resolveConfigPath();

  try {
    const config = await loadConfig(configPath);
    const di = createContainer({ config, logger });
    const server = createMcpServer(di);
    const transport = new StdioServerTransport();

    logger.info('Starting Flutter Knowledge MCP server', {
      configPath,
      repositoriesRoot: config.repositoriesRoot,
    });

    await server.connect(transport);
  } catch (error) {
    const structured =
      error instanceof AppError
        ? { code: error.code, message: error.message, details: error.details }
        : {
            code: 'InternalError',
            message: error instanceof Error ? error.message : 'Unknown startup failure',
          };

    logger.error('Failed to start MCP server', structured);
    process.exitCode = 1;
  }
}

function resolveConfigPath(): string {
  const fromEnv = process.env.FLUTTER_KNOWLEDGE_CONFIG;
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  // Prefer config.json next to the package root when running from dist/ or src/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, '..');
  return path.join(packageRoot, 'config.json');
}

void main();

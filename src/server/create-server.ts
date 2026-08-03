import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DependencyContainer } from 'tsyringe';
import { registerTools } from '../tools/register-tools.js';

export const SERVER_NAME = 'flutter-knowledge-mcp';
export const SERVER_VERSION = '0.6.1';

export function createMcpServer(di: DependencyContainer): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerTools(server, di);
  return server;
}

import type { MCPServerConfig } from './persistence/types.js';
import type { MCPSecretValue } from './router/schemas.js';
import { decryptWithPrivateKey } from './utils/encryption.js';

export type CliMcpServer =
  | {
      type: 'local';
      command: string[];
      environment?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    }
  | {
      type: 'remote';
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    };

export class McpConfigurationError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'McpConfigurationError';
  }
}

function materializeSecretValueRecord(
  values: Record<string, MCPSecretValue> | undefined,
  privateKey: string | undefined,
  label: string
): Record<string, string> | undefined {
  if (!values || Object.keys(values).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    if (!privateKey) {
      throw new McpConfigurationError(
        `${label} cannot be decrypted because the worker decryption key is unavailable`
      );
    }
    try {
      out[key] = decryptWithPrivateKey(value, privateKey);
    } catch {
      throw new McpConfigurationError(`${label} contains an invalid encrypted value`);
    }
  }
  return out;
}

export function materializeMcpServers(
  mcpServers: Record<string, MCPServerConfig>,
  privateKey: string | undefined
): Record<string, CliMcpServer> {
  const out: Record<string, CliMcpServer> = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.type === 'local') {
      const environment = materializeSecretValueRecord(
        server.environment,
        privateKey,
        `MCP server "${name}" environment`
      );
      out[name] = {
        type: 'local',
        command: server.command,
        ...(environment !== undefined && { environment }),
        ...(server.enabled !== undefined && { enabled: server.enabled }),
        ...(server.timeout !== undefined && { timeout: server.timeout }),
      };
      continue;
    }
    const headers = materializeSecretValueRecord(
      server.headers,
      privateKey,
      `MCP server "${name}" headers`
    );
    out[name] = {
      type: 'remote',
      url: server.url,
      ...(headers !== undefined && { headers }),
      ...(server.enabled !== undefined && { enabled: server.enabled }),
      ...(server.timeout !== undefined && { timeout: server.timeout }),
    };
  }
  return out;
}

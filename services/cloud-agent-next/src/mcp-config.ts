import { z } from 'zod';
import type { MCPServerConfig } from './persistence/types.js';
import type { MCPSecretValue } from './router/schemas.js';
import { sessionAttachMcpServersSchema } from './shared/sandbox-control-protocol.js';
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

export type McpConfigurationErrorCode = 'key_unavailable' | 'invalid_encrypted_value';

export class McpConfigurationError extends Error {
  readonly retryable = false;

  constructor(
    message: string,
    readonly code: McpConfigurationErrorCode = 'invalid_encrypted_value'
  ) {
    super(message);
    this.name = 'McpConfigurationError';
  }
}

/**
 * Static, value-free reasons for the two decryption failures. The raw
 * `materializeMcpServers` message names the server; the worker must not echo it
 * (B3 sanitized-reason rule).
 */
export function mcpConfigurationFailureReason(error: McpConfigurationError): string {
  return error.code === 'key_unavailable'
    ? 'MCP server secret values cannot be decrypted because the worker decryption key is unavailable'
    : 'MCP server secret values contain an invalid encrypted value';
}

/**
 * A materialized MCP payload the worker refuses before any route exists or
 * before a `session.prepare` frame is sent. The message is a fixed field/limit
 * reason capped at 512 characters (no dynamic server/header names or values).
 */
export class McpAttachValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'McpAttachValidationError';
  }
}

const INVALID_MCP_PAYLOAD = 'Invalid session.attach payload';
const MCP_SERVER_COUNT_MESSAGE = 'A session can have at most 20 MCP servers';
const MCP_ENTRY_COUNT_MESSAGE =
  'An MCP server can have at most 50 environment variables or headers';
const MCP_SERIALIZED_SIZE_MESSAGE = 'Serialized MCP configuration exceeds the 80 KiB limit';
export const MAX_MCP_VALIDATION_MESSAGE_LENGTH = 512;

type ValidationIssue = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  maximum?: unknown;
  issues?: readonly { code: string; maximum?: unknown }[];
};

function issueMaximum(issue: ValidationIssue): unknown {
  if (issue.maximum !== undefined) return issue.maximum;
  return issue.issues?.[0]?.maximum;
}

/**
 * Maps `sessionAttachMcpServersSchema` issues onto a fixed, value-free field or
 * limit reason (ported from the upstream `frames.ts` attach mapper). Dynamic
 * server/header names and values never appear in the result.
 */
export function sessionAttachMcpValidationReason(
  issues: ReadonlyArray<ValidationIssue>
): string | undefined {
  for (const issue of issues) {
    const [root, _serverName, field] = issue.path;
    if (root !== 'mcp') continue;

    if (issue.path.length === 1) {
      if (
        issue.message === MCP_SERVER_COUNT_MESSAGE ||
        issue.message === MCP_SERIALIZED_SIZE_MESSAGE
      )
        return issue.message === MCP_SERVER_COUNT_MESSAGE
          ? MCP_SERVER_COUNT_MESSAGE
          : MCP_SERIALIZED_SIZE_MESSAGE;
      continue;
    }

    if (
      issue.path.length === 2 &&
      (issue.code === 'too_small' || issue.code === 'too_big' || issue.code === 'invalid_key')
    ) {
      return 'MCP server names must be between 1 and 100 characters';
    }

    if (field === 'timeout') {
      return 'MCP server timeout must be a positive integer no greater than 3600000 ms';
    }

    if (field === 'command' && (issue.code === 'too_small' || issue.code === 'too_big')) {
      return issue.path.length === 3
        ? 'MCP server commands must contain between 1 and 50 arguments'
        : 'MCP server command arguments must not exceed 8192 characters';
    }

    if (field === 'url' && issue.code === 'too_big')
      return 'MCP server URLs must not exceed 4096 characters';

    if (field !== 'headers' && field !== 'environment') continue;
    if (issue.path.length === 3 && issue.message === MCP_ENTRY_COUNT_MESSAGE)
      return MCP_ENTRY_COUNT_MESSAGE;

    const maximum = issueMaximum(issue);
    if (issue.code === 'invalid_key' || maximum === 256 || issue.code === 'too_small')
      return field === 'headers'
        ? 'MCP server header names must be between 1 and 256 characters'
        : 'MCP server environment variable names must be between 1 and 256 characters';
    if (maximum === 8192)
      return field === 'headers'
        ? 'MCP server header values must not exceed 8192 characters'
        : 'MCP server environment variable values must not exceed 8192 characters';
  }
}

/** `Invalid session.attach payload[: reason]`, capped at 512 characters. */
export function mcpValidationMessage(reason: string | undefined): string {
  return (reason ? `${INVALID_MCP_PAYLOAD}: ${reason}` : INVALID_MCP_PAYLOAD).slice(
    0,
    MAX_MCP_VALIDATION_MESSAGE_LENGTH
  );
}

/**
 * Validates a materialized MCP map and returns either the parsed map or a fixed
 * reason. Wrapping in `{ mcp }` roots the schema's refine issues at `mcp`, which
 * is what `sessionAttachMcpValidationReason` expects.
 */
export function parseSessionAttachMcpServers(
  mcp: Record<string, CliMcpServer>
): { success: true; data: Record<string, CliMcpServer> } | { success: false; reason: string } {
  const parsed = z.object({ mcp: sessionAttachMcpServersSchema }).safeParse({ mcp });
  if (parsed.success) return { success: true, data: parsed.data.mcp };
  return {
    success: false,
    reason: mcpValidationMessage(sessionAttachMcpValidationReason(parsed.error.issues)),
  };
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
        `${label} cannot be decrypted because the worker decryption key is unavailable`,
        'key_unavailable'
      );
    }
    try {
      out[key] = decryptWithPrivateKey(value, privateKey);
    } catch {
      throw new McpConfigurationError(
        `${label} contains an invalid encrypted value`,
        'invalid_encrypted_value'
      );
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

import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_MCP_VALIDATION_MESSAGE_LENGTH,
  McpConfigurationError,
  materializeMcpServers,
  mcpConfigurationFailureReason,
  mcpValidationMessage,
  parseSessionAttachMcpServers,
  sessionAttachMcpValidationReason,
  type CliMcpServer,
} from './mcp-config.js';
import { encryptWithPublicKey } from './utils/encryption.js';

let publicKey: string;
let privateKey: string;
let wrongPrivateKey: string;

beforeAll(() => {
  function pair() {
    return generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
  ({ publicKey, privateKey } = pair());
  ({ privateKey: wrongPrivateKey } = pair());
});

function reasonFor(mcp: Record<string, unknown>): string {
  const parsed = parseSessionAttachMcpServers(mcp as Record<string, CliMcpServer>);
  if (parsed.success) throw new Error('expected validation to fail');
  return parsed.reason;
}

describe('materializeMcpServers', () => {
  it('decrypts encrypted headers and passes plain values through', () => {
    const materialized = materializeMcpServers(
      {
        github: {
          type: 'remote',
          url: 'https://mcp.example.com/github',
          headers: {
            'X-Plain': 'plain',
            Authorization: encryptWithPublicKey('secret-header', publicKey),
          },
        },
      },
      privateKey
    );
    expect(materialized).toEqual({
      github: {
        type: 'remote',
        url: 'https://mcp.example.com/github',
        headers: { 'X-Plain': 'plain', Authorization: 'secret-header' },
      },
    });
  });

  it('reports a static, name-free reason for each decryption failure', () => {
    const servers = {
      github: {
        type: 'remote' as const,
        url: 'https://mcp.example.com/github',
        headers: { Authorization: encryptWithPublicKey('secret', publicKey) },
      },
    };
    const noKey = (() => {
      try {
        materializeMcpServers(servers, undefined);
      } catch (error) {
        return error;
      }
    })();
    expect(noKey).toBeInstanceOf(McpConfigurationError);
    expect(mcpConfigurationFailureReason(noKey as McpConfigurationError)).not.toContain('github');

    const wrongKey = (() => {
      try {
        materializeMcpServers(servers, wrongPrivateKey);
      } catch (error) {
        return error;
      }
    })();
    expect(wrongKey).toBeInstanceOf(McpConfigurationError);
    expect(mcpConfigurationFailureReason(wrongKey as McpConfigurationError)).not.toContain(
      'github'
    );
  });
});

describe('parseSessionAttachMcpServers reasons', () => {
  const remote = (extra: Record<string, unknown> = {}) => ({
    type: 'remote',
    url: 'https://mcp.example.com/x',
    ...extra,
  });

  it('accepts an empty command argument', () => {
    expect(
      parseSessionAttachMcpServers({ local: { type: 'local', command: ['node', '-e', ''] } })
    ).toEqual({ success: true, data: { local: { type: 'local', command: ['node', '-e', ''] } } });
  });

  it('maps the server-count limit', () => {
    const servers = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`server-${index}`, remote()])
    );
    expect(reasonFor(servers)).toBe(
      'Invalid session.attach payload: A session can have at most 20 MCP servers'
    );
  });

  it('maps the entry-count limit', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`H${index}`, 'v'])
    );
    expect(reasonFor({ remote: remote({ headers }) })).toBe(
      'Invalid session.attach payload: An MCP server can have at most 50 environment variables or headers'
    );
  });

  it('maps the timeout limit without echoing the value', () => {
    expect(reasonFor({ remote: remote({ timeout: 1.5 }) })).toBe(
      'Invalid session.attach payload: MCP server timeout must be a positive integer no greater than 3600000 ms'
    );
  });

  it('maps the command-count and argument-length limits', () => {
    expect(
      reasonFor({ local: { type: 'local', command: Array.from({ length: 51 }, () => 'x') } })
    ).toBe(
      'Invalid session.attach payload: MCP server commands must contain between 1 and 50 arguments'
    );
    expect(reasonFor({ local: { type: 'local', command: ['x'.repeat(8193)] } })).toBe(
      'Invalid session.attach payload: MCP server command arguments must not exceed 8192 characters'
    );
  });

  it('maps the URL limit', () => {
    expect(
      reasonFor({ remote: { type: 'remote', url: `https://x.test/${'a'.repeat(4096)}` } })
    ).toBe('Invalid session.attach payload: MCP server URLs must not exceed 4096 characters');
  });

  it('maps header and environment name/value limits with a static field name', () => {
    expect(reasonFor({ remote: remote({ headers: { ['h'.repeat(257)]: 'v' } }) })).toBe(
      'Invalid session.attach payload: MCP server header names must be between 1 and 256 characters'
    );
    expect(reasonFor({ remote: remote({ headers: { Authorization: 'v'.repeat(8193) } }) })).toBe(
      'Invalid session.attach payload: MCP server header values must not exceed 8192 characters'
    );
    expect(
      reasonFor({
        local: { type: 'local', command: ['node'], environment: { KEY: 'v'.repeat(8193) } },
      })
    ).toBe(
      'Invalid session.attach payload: MCP server environment variable values must not exceed 8192 characters'
    );
  });

  it('maps the server-name limit without echoing the name', () => {
    const name = 's'.repeat(101);
    const reason = reasonFor({ [name]: remote() });
    expect(reason).toBe(
      'Invalid session.attach payload: MCP server names must be between 1 and 100 characters'
    );
    expect(reason).not.toContain(name);
  });

  it('caps the sanitized message at 512 characters', () => {
    expect(mcpValidationMessage('x'.repeat(600)).length).toBe(MAX_MCP_VALIDATION_MESSAGE_LENGTH);
    expect(
      sessionAttachMcpValidationReason([{ code: 'custom', path: ['other'], message: 'ignored' }])
    ).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { encryptWithPublicKey } from '@kilocode/encryption';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../shared/runtime-environment.js';
import { sessionAttachPayloadSchema } from '../shared/sandbox-control-protocol.js';
import { envVarsSchema } from '../types.js';
import {
  adaptSessionAttachPayloadForWrapper,
  buildSessionAttachPayload,
} from './attach-payload.js';

const mcpKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const mcpPublicKey = mcpKeyPair.publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const mcpPrivateKey = mcpKeyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('buildSessionAttachPayload', () => {
  it('packs directory, git clone, branch, snapshot identity, and session env', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userId: 'user-1',
        orgId: 'org-1',
      },
      auth: { kiloSessionId: 'kilo_1', kilocodeToken: 'cap_1' },
      agent: { mode: 'code', model: 'kilo/test' },
      repository: { type: 'github', repo: 'acme/demo', token: 'gh_token', upstreamBranch: 'main' },
      workspace: {},
      lifecycle: { version: 1, timestamp: 1 },
    });
    expect(buildSessionAttachPayload(metadata)).toEqual({
      snapshotIdentity: 'kilo_1',
      directory: expect.stringContaining('workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      branch: 'main',
      git: {
        url: 'https://github.com/acme/demo.git',
        platform: 'github',
        token: 'gh_token',
      },
      env: { KILOCODE_TOKEN: 'cap_1' },
    });
  });

  it('packs setup commands, injected auth env, and preparation identity', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userId: 'user-1',
      },
      auth: { kiloSessionId: 'kilo_1', kilocodeToken: 'cap_1' },
      agent: { mode: 'code', model: 'kilo/test' },
      profile: { envVars: {}, encryptedSecrets: {}, setupCommands: ['pnpm install'] },
      workspace: { workspacePath: '/workspace/a' },
      lifecycle: { version: 1, timestamp: 1 },
    });
    expect(
      buildSessionAttachPayload(metadata, { attemptId: 'att_1', triggerMessageId: 'msg_1' })
    ).toEqual({
      snapshotIdentity: 'kilo_1',
      directory: '/workspace/a',
      env: { KILOCODE_TOKEN: 'cap_1' },
      setupCommands: ['pnpm install'],
      preparation: { attemptId: 'att_1', triggerMessageId: 'msg_1' },
    });
  });

  it('materializes profile MCP servers for ordinary Bitbucket sessions before attach', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userId: 'user-1',
      },
      auth: { kiloSessionId: 'kilo_1', kilocodeToken: 'cap_1' },
      agent: { mode: 'code', model: 'kilo/test' },
      repository: {
        type: 'bitbucket',
        url: 'https://bitbucket.org/acme/demo.git',
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      },
      profile: {
        mcpServers: {
          local: {
            type: 'local',
            command: ['npx', 'local-mcp'],
            environment: {
              API_TOKEN: encryptWithPublicKey('local-secret', mcpPublicKey),
            },
          },
          remote: {
            type: 'remote',
            url: 'https://mcp.example.test/connect',
            headers: {
              Authorization: encryptWithPublicKey('Bearer remote-secret', mcpPublicKey),
            },
          },
        },
      },
      lifecycle: { version: 1, timestamp: 1 },
    });

    expect(buildSessionAttachPayload(metadata, undefined, mcpPrivateKey).mcp).toEqual({
      local: {
        type: 'local',
        command: ['npx', 'local-mcp'],
        environment: { API_TOKEN: 'local-secret' },
      },
      remote: {
        type: 'remote',
        url: 'https://mcp.example.test/connect',
        headers: { Authorization: 'Bearer remote-secret' },
      },
    });
  });

  it('omits encrypted local and remote MCP servers for read-only Bitbucket reviews', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174099',
        createdOnPlatform: 'code-review',
      },
      auth: { kiloSessionId: 'kilo_1', kilocodeToken: 'cap_1' },
      agent: { mode: 'code', model: 'kilo/test' },
      repository: {
        type: 'bitbucket',
        url: 'https://bitbucket.org/acme/demo.git',
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      },
      callback: {
        target: {
          url: 'https://kilo.example/api/internal/code-review-status/review_123?attemptId=attempt-1',
        },
      },
      profile: {
        mcpServers: {
          local: {
            type: 'local',
            command: ['npx', 'local-mcp'],
            environment: {
              API_TOKEN: encryptWithPublicKey('local-secret', mcpPublicKey),
            },
          },
          remote: {
            type: 'remote',
            url: 'https://mcp.example.test/connect',
            headers: {
              Authorization: encryptWithPublicKey('Bearer remote-secret', mcpPublicKey),
            },
          },
        },
      },
      lifecycle: { version: 1, timestamp: 1 },
    });

    expect(buildSessionAttachPayload(metadata)).not.toHaveProperty('mcp');
  });

  it('fails closed when an encrypted MCP value has no worker private key', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userId: 'user-1',
      },
      auth: { kiloSessionId: 'kilo_1' },
      profile: {
        mcpServers: {
          remote: {
            type: 'remote',
            url: 'https://mcp.example.test/connect',
            headers: {
              Authorization: encryptWithPublicKey('Bearer remote-secret', mcpPublicKey),
            },
          },
        },
      },
      lifecycle: { version: 1, timestamp: 1 },
    });

    expect(() => buildSessionAttachPayload(metadata)).toThrow(
      'MCP server "remote" headers cannot be decrypted because the worker decryption key is unavailable'
    );
  });

  it('marks a generated workspace branch as a working branch', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userId: 'user-1',
      },
      auth: { kiloSessionId: 'kilo_1', kilocodeToken: 'cap_1' },
      agent: { mode: 'code', model: 'kilo/test' },
      repository: { type: 'github', repo: 'acme/demo' },
      workspace: { branchName: 'kilo/quiet-forest-abc' },
      lifecycle: { version: 1, timestamp: 1 },
    });

    expect(buildSessionAttachPayload(metadata)).toMatchObject({
      branch: 'kilo/quiet-forest-abc',
      branchMode: 'working',
    });
  });

  it('drops working-branch fields for a legacy wrapper', () => {
    const payload = {
      branch: 'kilo/quiet-forest-abc',
      branchMode: 'working' as const,
      directory: '/workspace/a',
    };

    expect(adaptSessionAttachPayloadForWrapper(payload, true)).toEqual(payload);
    expect(adaptSessionAttachPayloadForWrapper(payload, false)).toEqual({
      directory: '/workspace/a',
    });
  });

  it('drops the git author for a wrapper that does not support it', () => {
    const payload = {
      directory: '/workspace/a',
      git: {
        url: 'https://github.com/acme/demo.git',
        platform: 'github' as const,
        author: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
      },
    };

    expect(adaptSessionAttachPayloadForWrapper(payload, true, true)).toEqual(payload);
    expect(adaptSessionAttachPayloadForWrapper(payload, true, false)).toEqual({
      directory: '/workspace/a',
      git: { url: 'https://github.com/acme/demo.git', platform: 'github' },
    });
  });

  it('keeps MCP servers for a supported wrapper and isolates its runtime', () => {
    const payload = {
      directory: '/workspace/a',
      mcp: { remote: { type: 'remote' as const, url: 'https://mcp.example.test/connect' } },
    };

    expect(adaptSessionAttachPayloadForWrapper(payload, true, true)).toEqual({
      ...payload,
      runtimeIsolation: 'per-session',
    });
  });

  it('accepts only materialized MCP values in the attach protocol', () => {
    expect(
      sessionAttachPayloadSchema.safeParse({
        mcp: {
          remote: {
            type: 'remote',
            url: 'https://mcp.example.test/connect',
            headers: { Authorization: 'Bearer secret' },
          },
        },
      }).success
    ).toBe(true);
    expect(
      sessionAttachPayloadSchema.safeParse({
        mcp: {
          remote: {
            type: 'remote',
            url: 'https://mcp.example.test/connect',
            headers: { Authorization: encryptWithPublicKey('Bearer secret', mcpPublicKey) },
          },
        },
      }).success
    ).toBe(false);
    expect(
      sessionAttachPayloadSchema.safeParse({
        mcp: {
          local: { type: 'local', command: ['node', '-e', ''] },
        },
      }).success
    ).toBe(true);
  });

  it.each(['\u96ea', '\n'])(
    'bounds the UTF-8 serialized MCP configuration for %j values',
    value => {
      const result = sessionAttachPayloadSchema.safeParse({
        mcp: {
          local: {
            type: 'local',
            command: ['node', '-e', ''],
            environment: Object.fromEntries(
              Array.from({ length: 12 }, (_, index) => [`VALUE_${index}`, value.repeat(4096)])
            ),
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map(issue => issue.message)).toContain(
          'Serialized MCP configuration exceeds the 80 KiB limit'
        );
      }
    }
  );

  it.each(['local', 'remote'])('rejects fractional %s MCP request timeouts', type => {
    expect(
      sessionAttachPayloadSchema.safeParse({
        mcp: {
          server: {
            type,
            ...(type === 'local' ? { command: ['node'] } : { url: 'https://mcp.example.test' }),
            timeout: 500.5,
          },
        },
      }).success
    ).toBe(false);
  });

  for (const key of CONTROL_RUNTIME_RESERVED_ENV_VARS) {
    it(`rejects ${key} in public session environment variables`, () => {
      const result = envVarsSchema.safeParse({ [key]: 'user-controlled-secret' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain(key);
        expect(result.error.message).not.toContain('user-controlled-secret');
      }
    });

    it(`rejects persisted profile environment variable ${key} before attach`, () => {
      const metadata = parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: {
          sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          userId: 'user-1',
        },
        auth: { kiloSessionId: 'kilo_1' },
        profile: { envVars: { [key]: 'user-controlled-secret' } },
        lifecycle: { version: 1, timestamp: 1 },
      });

      expect(() => buildSessionAttachPayload(metadata)).toThrow(
        `Reserved control runtime environment variable: ${key}`
      );
    });

    it(`rejects persisted encrypted secret name ${key} before attach`, () => {
      const metadata = parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: {
          sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          userId: 'user-1',
        },
        auth: { kiloSessionId: 'kilo_1' },
        profile: {
          encryptedSecrets: {
            [key]: {
              encryptedData: 'encrypted-secret-value',
              encryptedDEK: 'encrypted-data-key',
              algorithm: 'rsa-aes-256-gcm',
              version: 1,
            },
          },
        },
        lifecycle: { version: 1, timestamp: 1 },
      });

      expect(() => buildSessionAttachPayload(metadata)).toThrow(
        `Reserved control runtime environment variable: ${key}`
      );
    });
  }
});

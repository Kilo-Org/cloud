import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';
import { CurrentSessionMetadataSchema } from '../../persistence/session-metadata.js';
import {
  controlPlanePrepareInputSchema,
  controlPlaneRouteSpecSchema,
} from '../../shared/control-plane-protocol.js';
import { encryptWithPublicKey } from '../../utils/encryption.js';
import { getSessionWorkspacePath, getWorktreeWorkspacePath } from '../../workspace.js';
import { buildControlPlaneSessionRegistration } from './registration.js';

function generateKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

let publicKey: string;
let privateKey: string;
let wrongPrivateKey: string;

beforeAll(() => {
  ({ publicKey, privateKey } = generateKeyPair());
  ({ privateKey: wrongPrivateKey } = generateKeyPair());
});

function metadata(overrides: Record<string, unknown> = {}) {
  return CurrentSessionMetadataSchema.parse({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      userId: 'usr_1',
      createdOnPlatform: 'cloud-agent',
    },
    auth: {
      kiloSessionId: 'ses_12345678901234567890123456',
      kilocodeToken: 'native-kilo-token',
    },
    agent: { mode: 'code', model: 'kilo/fake-deterministic' },
    workspace: { sandboxId: 'ses-0123456789abcdef', sandboxProvider: 'cloudflare' },
    lifecycle: { version: 1, timestamp: 1 },
    ...overrides,
  });
}

const selection = { provider: 'cloudflare' as const };

describe('runtime authorization admission', () => {
  it.each(['cloudflare', 'cloudflare-containers', 'vercel'] as const)(
    'isolates modern %s runtimes and freezes the admission containment selection',
    provider => {
      const modern = metadata({
        auth: {
          kiloSessionId: 'ses_12345678901234567890123456',
          kilocodeToken: jwt.sign({ runtimeAuthorization: { id: crypto.randomUUID() } }, 'test'),
        },
        workspace: { sandboxId: 'ses-0123456789abcdef', sandboxProvider: provider },
      });
      const registration = buildControlPlaneSessionRegistration(modern, { provider }, undefined, {
        containmentEnabled: true,
        workerUrl: 'https://worker.test',
      });
      expect(registration.spec.runtimeIsolation).toBe('per-session');
      expect(registration.spec.env?.KILOCODE_TOKEN).toBeUndefined();
      expect(registration.sandboxSelection?.containment).toEqual({
        kilocode: true,
        github: true,
        worktreeScoped: true,
      });
    }
  );

  it('preserves direct SCM admission independently of modern runtime authorization', () => {
    const modern = metadata({
      auth: {
        kiloSessionId: 'ses_12345678901234567890123456',
        kilocodeToken: jwt.sign({ runtimeAuthorization: { id: crypto.randomUUID() } }, 'test'),
      },
    });
    const registration = buildControlPlaneSessionRegistration(
      modern,
      { ...selection, containment: { kilocode: false, github: false, worktreeScoped: true } },
      undefined,
      { containmentEnabled: true, workerUrl: 'https://worker.test' }
    );
    expect(registration.spec.runtimeIsolation).toBe('per-session');
    expect(registration.sandboxSelection?.containment).toMatchObject({
      kilocode: false,
      github: false,
    });
  });

  it('rejects unsupported Vercel direct mode and invalid modern proxy configuration at registration', () => {
    const vercel = metadata({
      workspace: { sandboxId: 'ses-0123456789abcdef', sandboxProvider: 'vercel' },
    });
    expect(() =>
      buildControlPlaneSessionRegistration(vercel, {
        provider: 'vercel',
        containment: { kilocode: false, github: false },
      })
    ).toThrow('Vercel requires credential containment');
    const modern = metadata({
      auth: {
        kiloSessionId: 'ses_12345678901234567890123456',
        kilocodeToken: jwt.sign({ runtimeAuthorization: { id: crypto.randomUUID() } }, 'test'),
      },
    });
    expect(() =>
      buildControlPlaneSessionRegistration(modern, selection, undefined, {
        containmentEnabled: false,
        workerUrl: 'http://worker.test',
      })
    ).toThrow('Runtime credential proxy configuration is unavailable');
  });
});

describe('buildControlPlaneSessionRegistration MCP materialization', () => {
  it('keeps materialized servers out of the spec and isolates the session', () => {
    const registration = buildControlPlaneSessionRegistration(
      metadata({
        profile: {
          mcpServers: {
            github: {
              type: 'remote',
              url: 'https://mcp.example.com/github',
              headers: { 'X-Plain': 'plain-header' },
              timeout: 30_000,
            },
            local: {
              type: 'local',
              command: ['node', '-e', ''],
              environment: { PLAIN: 'local-env' },
            },
          },
        },
      }),
      selection
    );

    // Plaintext MCP must never be persisted into the route spec.
    expect(registration.spec.mcp).toBeUndefined();
    // Materialized MCP is per-session user config and must not share a runtime.
    expect(registration.spec.runtimeIsolation).toBe('per-session');
    // The encrypted snapshot rides the DO-private credential source.
    expect(registration.credentials.mcpServers).toEqual({
      github: {
        type: 'remote',
        url: 'https://mcp.example.com/github',
        headers: { 'X-Plain': 'plain-header' },
        timeout: 30_000,
      },
      local: { type: 'local', command: ['node', '-e', ''], environment: { PLAIN: 'local-env' } },
    });
  });

  it('decrypts encrypted header values transiently without persisting them', () => {
    const envelope = encryptWithPublicKey('secret-header', publicKey);
    const registration = buildControlPlaneSessionRegistration(
      metadata({
        profile: {
          mcpServers: {
            github: {
              type: 'remote',
              url: 'https://mcp.example.com/github',
              headers: { Authorization: envelope },
            },
          },
        },
      }),
      selection,
      privateKey
    );
    expect(registration.spec.mcp).toBeUndefined();
    expect(registration.credentials.mcpServers).toEqual({
      github: {
        type: 'remote',
        url: 'https://mcp.example.com/github',
        headers: { Authorization: envelope },
      },
    });
    // The decrypted value survives only in memory.
    expect(JSON.stringify(registration)).not.toContain('secret-header');
  });

  it('fails closed when an encrypted value has no decryption key', () => {
    expect(() =>
      buildControlPlaneSessionRegistration(
        metadata({
          profile: {
            mcpServers: {
              github: {
                type: 'remote',
                url: 'https://mcp.example.com/github',
                headers: { Authorization: encryptWithPublicKey('secret-header', publicKey) },
              },
            },
          },
        }),
        selection
      )
    ).toThrow(/worker decryption key is unavailable/);
  });

  it('fails closed when an encrypted value cannot be decrypted', () => {
    expect(() =>
      buildControlPlaneSessionRegistration(
        metadata({
          profile: {
            mcpServers: {
              github: {
                type: 'remote',
                url: 'https://mcp.example.com/github',
                headers: { Authorization: encryptWithPublicKey('secret-header', publicKey) },
              },
            },
          },
        }),
        selection,
        wrongPrivateKey
      )
    ).toThrow(/contain an invalid encrypted value/);
  });

  it('omits MCP for a read-only Bitbucket code review', () => {
    const registration = buildControlPlaneSessionRegistration(
      metadata({
        identity: {
          sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
          userId: 'usr_1',
          createdOnPlatform: 'code-review',
        },
        repository: {
          type: 'bitbucket',
          url: 'https://bitbucket.org/acme/repo.git',
          workspaceUuid: '11111111-1111-4111-8111-111111111111',
          repositoryUuid: '22222222-2222-4222-8222-222222222222',
        },
        callback: { target: { url: 'https://app.test/api/internal/code-review-status/rev_123' } },
        profile: {
          mcpServers: {
            github: {
              type: 'remote',
              url: 'https://mcp.example.com/github',
              // An envelope with no key proves the read-only guard runs before
              // any decryption attempt (which would throw here).
              headers: { Authorization: encryptWithPublicKey('secret', publicKey) },
            },
          },
        },
      }),
      selection
    );

    // No decryption and no credential-source snapshot for a read-only review.
    expect(registration.spec.mcp).toBeUndefined();
    expect(registration.credentials.mcpServers).toBeUndefined();
  });

  it('rejects a materialized config over the 80 KiB protocol limit with a static reason', () => {
    const environment = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`KEY_${index}`, 'x'.repeat(2048)])
    );
    expect(() =>
      buildControlPlaneSessionRegistration(
        metadata({
          profile: { mcpServers: { local: { type: 'local', command: ['node'], environment } } },
        }),
        selection
      )
    ).toThrow(/Serialized MCP configuration exceeds the 80 KiB limit/);
  });
});

describe('controlPlaneRouteSpecSchema MCP boundaries', () => {
  function spec(mcp: unknown): unknown {
    return {
      sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'ses_12345678901234567890123456',
      directory: '/tmp/worktree',
      attemptId: 'attempt-1',
      mcp,
    };
  }

  it('preserves an empty command argument', () => {
    const parsed = controlPlaneRouteSpecSchema.safeParse(
      spec({ local: { type: 'local', command: ['node', '-e', ''] } })
    );
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.mcp?.local).toEqual({ type: 'local', command: ['node', '-e', ''] });
  });

  it('rejects more than 20 servers', () => {
    const servers = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `server-${index}`,
        { type: 'remote', url: 'https://mcp.example.com/x' },
      ])
    );
    expect(controlPlaneRouteSpecSchema.safeParse(spec(servers)).success).toBe(false);
  });

  it('rejects more than 50 header values on one server', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`H_${index}`, 'v'])
    );
    expect(
      controlPlaneRouteSpecSchema.safeParse(
        spec({ remote: { type: 'remote', url: 'https://mcp.example.com/x', headers } })
      ).success
    ).toBe(false);
  });

  it('rejects an oversized header value', () => {
    expect(
      controlPlaneRouteSpecSchema.safeParse(
        spec({
          remote: {
            type: 'remote',
            url: 'https://mcp.example.com/x',
            headers: { Authorization: 'x'.repeat(8193) },
          },
        })
      ).success
    ).toBe(false);
  });

  it('rejects a non-integer or non-positive timeout', () => {
    expect(
      controlPlaneRouteSpecSchema.safeParse(
        spec({ remote: { type: 'remote', url: 'https://mcp.example.com/x', timeout: 0 } })
      ).success
    ).toBe(false);
    expect(
      controlPlaneRouteSpecSchema.safeParse(
        spec({ remote: { type: 'remote', url: 'https://mcp.example.com/x', timeout: 1.5 } })
      ).success
    ).toBe(false);
  });

  it('rejects a materialized MCP spec on the prepare input', () => {
    const parsed = controlPlanePrepareInputSchema.safeParse({
      spec: spec({ local: { type: 'local', command: ['node'] } }),
      credentials: {
        userId: 'usr_1',
        kiloSessionId: 'ses_12345678901234567890123456',
        kiloToken: 'native-kilo-token',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a UTF-8 payload over the 80 KiB byte limit', () => {
    // Eleven headers of 3000 three-byte characters each: every value is under
    // the 8192-character cap, but the serialized UTF-8 bytes exceed 80 KiB.
    const headers = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`H${index}`, '✓'.repeat(3000)])
    );
    const servers = {
      remote: { type: 'remote', url: 'https://mcp.example.com/x', headers },
    };
    expect(controlPlaneRouteSpecSchema.safeParse(spec(servers)).success).toBe(false);
  });
});

describe('buildControlPlaneSessionRegistration session directory', () => {
  const SESSION_ID = 'workspace_12345678-1234-1234-1234-123456789abc';
  const SHARED_SANDBOX_ID = `usr-${'a'.repeat(48)}`;

  it('uses the isolated container directory for a ses-* sandbox with no explicit path', () => {
    const registration = buildControlPlaneSessionRegistration(metadata(), selection);

    expect(registration.spec.directory).toBe('/workspace/app');
  });

  it('uses the isolated container directory for an istd-* sandbox with no explicit path', () => {
    const registration = buildControlPlaneSessionRegistration(
      metadata({
        workspace: { sandboxId: 'istd-0123456789abcdef', sandboxProvider: 'cloudflare' },
      }),
      selection
    );

    expect(registration.spec.directory).toBe('/workspace/app');
  });

  it('keeps the per-session path for a shared personal sandbox', () => {
    const registration = buildControlPlaneSessionRegistration(
      metadata({ workspace: { sandboxId: SHARED_SANDBOX_ID, sandboxProvider: 'cloudflare' } }),
      selection
    );

    expect(registration.spec.directory).toBe(
      getSessionWorkspacePath(undefined, 'usr_1', SESSION_ID)
    );
    expect(registration.spec.directory).not.toBe('/workspace/app');
  });

  it('keeps the per-session path for a shared organization sandbox', () => {
    const registration = buildControlPlaneSessionRegistration(
      metadata({
        identity: {
          sessionId: SESSION_ID,
          userId: 'usr_1',
          orgId: 'org_1',
          createdOnPlatform: 'cloud-agent',
        },
        workspace: { sandboxId: SHARED_SANDBOX_ID, sandboxProvider: 'cloudflare' },
      }),
      selection
    );

    expect(registration.spec.directory).toBe(getSessionWorkspacePath('org_1', 'usr_1', SESSION_ID));
  });

  it.each([
    ['code-review', `crv-${'a'.repeat(48)}`],
    ['devcontainer', `dind-${'a'.repeat(48)}`],
  ])('keeps the per-session path for a %s sandbox', (_label, sandboxId) => {
    const registration = buildControlPlaneSessionRegistration(
      metadata({ workspace: { sandboxId, sandboxProvider: 'cloudflare' } }),
      selection
    );

    expect(registration.spec.directory).toBe(
      getSessionWorkspacePath(undefined, 'usr_1', SESSION_ID)
    );
  });

  it('uses the isolated container directory over an explicit worktree path', () => {
    const worktreeId = 'worktree_420ae020-e3c4-4e67-878b-66672c3d997e';
    const worktreePath = getWorktreeWorkspacePath(undefined, 'usr_1', worktreeId);
    const registration = buildControlPlaneSessionRegistration(
      metadata({
        workspace: {
          sandboxId: 'ses-0123456789abcdef',
          sandboxProvider: 'cloudflare',
          worktreeId,
          workspacePath: worktreePath,
        },
      }),
      selection
    );

    expect(registration.spec.directory).toBe('/workspace/app');
  });

  it('keeps the worktree path on a shared sandbox with the same explicit path', () => {
    const worktreeId = 'worktree_420ae020-e3c4-4e67-878b-66672c3d997e';
    const worktreePath = getWorktreeWorkspacePath(undefined, 'usr_1', worktreeId);
    const registration = buildControlPlaneSessionRegistration(
      metadata({
        workspace: {
          sandboxId: SHARED_SANDBOX_ID,
          sandboxProvider: 'cloudflare',
          worktreeId,
          workspacePath: worktreePath,
        },
      }),
      selection
    );

    expect(registration.spec.directory).toBe(worktreePath);
  });

  it('shares the isolated container directory across a worktree scope and keeps the identity path', () => {
    const worktreeId = 'worktree_420ae020-e3c4-4e67-878b-66672c3d997e';
    const worktreePath = getWorktreeWorkspacePath(undefined, 'usr_1', worktreeId);
    const siblingMetadata = (sessionId: string) =>
      metadata({
        identity: { sessionId, userId: 'usr_1', createdOnPlatform: 'cloud-agent' },
        workspace: {
          sandboxId: 'ses-0123456789abcdef',
          sandboxProvider: 'cloudflare',
          worktreeId,
          workspacePath: worktreePath,
        },
      });
    const firstInput = siblingMetadata('workspace_12345678-1234-1234-1234-123456789abc');
    const secondInput = siblingMetadata('workspace_abcdefab-abcd-abcd-abcd-abcdefabcdef');
    const first = buildControlPlaneSessionRegistration(firstInput, selection);
    const second = buildControlPlaneSessionRegistration(secondInput, selection);

    expect(first.spec.directory).toBe('/workspace/app');
    expect(second.spec.directory).toBe('/workspace/app');
    expect(first.credentials.scopeId).toBe(worktreeId);
    expect(second.credentials.scopeId).toBe(worktreeId);
    // Registration derives `spec.directory` without mutating the input metadata:
    // the identity worktree path must survive on the caller's object.
    expect(firstInput.workspace?.workspacePath).toBe(worktreePath);
    expect(secondInput.workspace?.workspacePath).toBe(worktreePath);
  });
});

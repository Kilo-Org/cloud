import { getSandbox } from '@cloudflare/sandbox';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { createAgentSandbox } from './factory.js';
import { CloudflareAgentSandbox } from './cloudflare/cloudflare-agent-sandbox.js';
import { VercelAgentSandbox } from './vercel/vercel-agent-sandbox.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

function metadata(provider?: 'cloudflare' | 'vercel'): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_sandbox', userId: 'user_sandbox' },
    auth: {},
    workspace: { sandboxId: 'ses-abcdef', ...(provider ? { sandboxProvider: provider } : {}) },
    lifecycle: { version: 1, timestamp: 1 },
  };
}

describe('AgentSandbox provider factory', () => {
  it.each([undefined, 'cloudflare'] as const)(
    'resolves %s metadata to the Cloudflare runtime adapter',
    provider => {
      expect(createAgentSandbox({} as Env, metadata(provider))).toBeInstanceOf(
        CloudflareAgentSandbox
      );
    }
  );

  it('resolves configured Vercel metadata to the exact-session adapter without Cloudflare bindings', () => {
    const sandbox = createAgentSandbox(
      {
        VERCEL_TOKEN: 'token',
        VERCEL_TEAM_ID: 'team',
        VERCEL_PROJECT_ID: 'project',
        VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot',
        VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build',
        VERCEL_SANDBOX_RUNTIME: 'node24',
        VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
        VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
      } as Env,
      metadata('vercel')
    );

    expect(sandbox).toBeInstanceOf(VercelAgentSandbox);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('uses persisted runtime identity instead of mutable enrollment snapshot values', () => {
    const pinned = metadata('vercel');
    pinned.workspace = {
      ...pinned.workspace,
      providerRuntime: {
        provider: 'vercel',
        sessionId: 'session-1',
        projectId: 'project-pinned',
        snapshotId: 'snapshot-pinned',
        runtimeBuildId: 'build-pinned',
        runtime: 'node24',
      },
    };
    const sandbox = createAgentSandbox(
      {
        VERCEL_TOKEN: 'token',
        VERCEL_TEAM_ID: 'team',
        VERCEL_PROJECT_ID: 'project-current',
        VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-current',
        VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build-current',
        VERCEL_SANDBOX_RUNTIME: 'node24',
        VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
        VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
      } as Env,
      pinned
    );

    expect((sandbox as any).config).toMatchObject({
      projectId: 'project-pinned',
      snapshotId: 'snapshot-pinned',
      runtimeBuildId: 'build-pinned',
    });
  });

  it('requires operational configuration only for Vercel metadata', () => {
    expect(() => createAgentSandbox({} as Env, metadata('vercel'))).toThrow(
      'Vercel sandbox operational configuration is incomplete'
    );
    expect(createAgentSandbox({} as Env, metadata('cloudflare'))).toBeInstanceOf(
      CloudflareAgentSandbox
    );
  });
});

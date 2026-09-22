import { getSandbox } from '@cloudflare/sandbox';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSandboxProvider, Env } from '../types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { createAgentSandbox } from './factory.js';
import { CloudflareAgentSandbox } from './cloudflare/cloudflare-agent-sandbox.js';
import { VercelAgentSandbox } from './vercel/vercel-agent-sandbox.js';
import { AgentSandboxUnavailableError } from './protocol.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

function metadata(provider?: AgentSandboxProvider): SessionMetadata {
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

  it('creates a Vercel adapter only with a persisted customer credential binding', () => {
    const pinned = metadata('vercel');
    pinned.workspace!.sandboxProviderBinding = {
      kind: 'vercel',
      source: { kind: 'byoc', userId: 'oauth/customer', credentialId: 'credential' },
    };
    expect(createAgentSandbox({} as Env, pinned)).toBeInstanceOf(VercelAgentSandbox);
    expect(getSandbox).not.toHaveBeenCalled();
  });
  it('rejects retired platform Vercel sessions even if old platform credentials remain configured', () => {
    const env = Object.assign({} as Env, {
      WORKER_URL: 'http://worker.test',
      VERCEL_TOKEN: 'retired-token',
      VERCEL_TEAM_ID: 'retired-team',
      VERCEL_PROJECT_ID: 'retired-project',
      VERCEL_SANDBOX_SNAPSHOT_ID: 'retired-snapshot',
    });
    expect(() => createAgentSandbox(env, metadata('vercel'))).toThrow(
      'Kilo-paid Vercel compute is retired'
    );
    expect(createAgentSandbox(env, metadata('cloudflare'))).toBeInstanceOf(CloudflareAgentSandbox);
  });

  it('fails closed for cloudflare-containers metadata on the legacy agent plane', () => {
    let thrown: unknown;
    try {
      createAgentSandbox({} as Env, metadata('cloudflare-containers'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentSandboxUnavailableError);
    expect((thrown as AgentSandboxUnavailableError).failure).toBe('capability_unavailable');
    expect((thrown as Error).message).toBe(
      'Cloudflare containers are not available on the legacy agent plane'
    );
  });
});

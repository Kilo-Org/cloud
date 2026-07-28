import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { createAgentSandbox } from './factory.js';
import { CloudflareAgentSandbox } from './cloudflare/cloudflare-agent-sandbox.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

function metadata(provider?: 'cloudflare'): SessionMetadata {
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
});

import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { createAgentSandbox } from './factory.js';
import { CloudflareAgentSandbox } from './cloudflare/cloudflare-agent-sandbox.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

function metadata(): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_sandbox', userId: 'user_sandbox' },
    auth: {},
    workspace: { sandboxId: 'ses-abcdef' },
    lifecycle: { version: 1, timestamp: 1 },
  };
}

describe('AgentSandbox factory', () => {
  it('constructs the Cloudflare runtime adapter', () => {
    expect(createAgentSandbox({} as Env, metadata())).toBeInstanceOf(CloudflareAgentSandbox);
  });
});

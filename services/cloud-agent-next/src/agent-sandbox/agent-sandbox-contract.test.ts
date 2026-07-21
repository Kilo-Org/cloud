import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { Env, SandboxInstance } from '../types.js';
import { CloudflareAgentSandbox } from './cloudflare/cloudflare-agent-sandbox.js';
import type { AgentSandbox } from './protocol.js';

/**
 * Shared behavioral contract every AgentSandbox adapter must satisfy for a
 * session with no running wrapper. Provider-specific flows (ensureWrapper,
 * workspace preparation, reconciliation) stay in the per-provider suites.
 */

function sessionMetadata(provider: 'cloudflare'): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_contract', userId: 'user_contract' },
    auth: {},
    workspace: { sandboxId: 'ses-abcdef', sandboxProvider: provider },
    lifecycle: { version: 1, timestamp: 1 },
  } satisfies SessionMetadata;
}

function idleCloudflareSandbox(): AgentSandbox {
  const sandbox = {
    listProcesses: vi.fn().mockResolvedValue([]),
    destroy: vi.fn().mockResolvedValue(undefined),
    renewActivityTimeout: vi.fn(),
  } as unknown as SandboxInstance;
  return new CloudflareAgentSandbox({} as Env, sessionMetadata('cloudflare'), {
    resolveSandbox: () => sandbox,
    sleep: () => Promise.resolve(),
    stopObservationDelaysMs: [0],
  });
}

describe.each([['cloudflare', idleCloudflareSandbox]] as const)(
  'AgentSandbox contract (%s)',
  (_provider, createIdleSandbox) => {
    it('reports absent wrappers when none are running', async () => {
      await expect(createIdleSandbox().discoverSessionWrappers()).resolves.toEqual({
        status: 'absent',
      });
    });

    it('treats stopping wrappers as settled when none are running', async () => {
      const result = await createIdleSandbox().stopWrappers({
        target: { kind: 'session' },
        attemptId: 'attempt-contract',
        reason: 'session-delete',
      });

      expect(result.status).toBe('absent');
    });

    it('scopes instance-targeted stops to the leased instance', async () => {
      const result = await createIdleSandbox().stopWrappers({
        target: {
          kind: 'instance',
          instance: { instanceId: 'instance-other', instanceGeneration: 7 },
        },
        attemptId: 'attempt-contract',
        reason: 'startup-failed',
      });

      expect(result.status).toBe('absent');
    });

    it('returns no running wrapper when none exists', async () => {
      await expect(createIdleSandbox().getRunningWrapper()).resolves.toBeNull();
    });

    it('resolves recovery deletion without throwing', async () => {
      await expect(createIdleSandbox().delete('recovery')).resolves.toBeUndefined();
    });

    it('keeps the sandbox alive without a running wrapper', async () => {
      await expect(createIdleSandbox().keepAlive()).resolves.toBeUndefined();
    });

    it('reports terminal availability as a declared capability outcome', async () => {
      const result = await createIdleSandbox().getRunningTerminalClient();

      expect(['ready', 'not-running', 'unhealthy', 'capability-unavailable']).toContain(
        result.status
      );
    });
  }
);

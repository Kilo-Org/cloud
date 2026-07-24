import { describe, expect, it, vi } from 'vitest';
import type { SandboxInstance } from './types.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import {
  assertSandboxBillingAllocation,
  buildSandboxBillingInput,
  configureSandboxBillingInput,
  SANDBOX_USAGE_SKUS,
} from './container-usage-context.js';

function metadata(identity: SessionMetadata['identity']): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity,
    auth: {},
    repository: { type: 'github', repo: 'Kilo-Org/cloud' },
    lifecycle: { version: 1, timestamp: 1 },
  };
}

describe('container usage context', () => {
  it('maps every concrete sandbox class to its immutable SKU', () => {
    expect(SANDBOX_USAGE_SKUS).toEqual({
      Sandbox: 'cloud-agent-standard-2026-07',
      SandboxContainment: 'cloud-agent-standard-2026-07',
      SandboxSmall: 'cloud-agent-small-2026-07',
      SandboxSmallContainment: 'cloud-agent-small-2026-07',
      SandboxDIND: 'cloud-agent-dind-2026-07',
      SandboxCodeReview: 'cloud-agent-code-review-2026-07',
      SandboxCodeReviewContainment: 'cloud-agent-code-review-2026-07',
    });
  });

  it.each([
    {
      name: 'personal human',
      identity: { sessionId: 'agent_personal', userId: 'user_personal' },
      expected: {
        subject: { type: 'user', id: 'user_personal' },
        actor: { type: 'user', id: 'user_personal' },
      },
    },
    {
      name: 'organization human',
      identity: { sessionId: 'agent_org', userId: 'user_org', orgId: 'org_1' },
      expected: {
        subject: { type: 'org', id: 'org_1' },
        actor: { type: 'user', id: 'user_org' },
      },
    },
    {
      name: 'personal bot',
      identity: { sessionId: 'agent_bot', userId: 'user_bot', botId: 'bot_1' },
      expected: {
        subject: { type: 'user', id: 'user_bot' },
        actor: { type: 'bot', id: 'bot_1' },
        onBehalfOf: { type: 'user', id: 'user_bot' },
      },
    },
    {
      name: 'organization bot',
      identity: {
        sessionId: 'agent_org_bot',
        userId: 'user_org_bot',
        orgId: 'org_2',
        botId: 'bot_2',
      },
      expected: {
        subject: { type: 'org', id: 'org_2' },
        actor: { type: 'bot', id: 'bot_2' },
        onBehalfOf: { type: 'org', id: 'org_2' },
      },
    },
  ])('derives trusted $name attribution', ({ identity, expected }) => {
    expect(buildSandboxBillingInput(metadata(identity), 'ses-abcdef')).toMatchObject(expected);
  });

  it('keeps isolated metadata bounded and normalizes automation origins', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_security',
        userId: 'user_security',
        orgId: 'org_security',
        billingOrigin: 'security-remediation',
      }),
      'crv-abcdef'
    );

    expect(input).toMatchObject({
      sandboxId: 'crv-abcdef',
      sessionId: 'agent_security',
      metadata: { origin: 'security-remediation' },
    });
    expect(JSON.stringify(input)).not.toContain('Kilo-Org/cloud');
  });

  it('omits session, origin, and repository metadata for shared containers', () => {
    const first = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_first',
        userId: 'user_shared',
        orgId: 'org_shared',
        billingOrigin: 'security-agent',
      }),
      'org-abcdef'
    );
    const second = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_second',
        userId: 'user_shared',
        orgId: 'org_shared',
        billingOrigin: 'cloud-agent-web',
      }),
      'org-abcdef'
    );

    expect(first).toEqual(second);
    expect(first).toEqual({
      sandboxId: 'org-abcdef',
      subject: { type: 'org', id: 'org_shared' },
      actor: { type: 'user', id: 'user_shared' },
    });
  });

  it('maps unknown caller-provided origins to other', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_unknown',
        userId: 'user_unknown',
        billingOrigin: 'attacker-controlled-value',
      }),
      'dind-abcdef'
    );
    expect(input.metadata?.origin).toBe('other');
  });

  it('does not positively attribute legacy metadata without a trusted billing origin', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_legacy',
        userId: 'user_legacy',
        createdOnPlatform: 'code-review',
      }),
      'crv-legacy'
    );
    expect(input.metadata?.origin).toBe('other');
  });

  it('does not trust the public createdOnPlatform label as billing origin', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_public',
        userId: 'user_public',
        createdOnPlatform: 'security-remediation',
        billingOrigin: 'cloud-agent',
      }),
      'ses-abcdef'
    );
    expect(input.metadata?.origin).toBe('cloud-agent');
  });

  it('rejects session attribution and extra metadata for shared sandboxes', () => {
    expect(() =>
      assertSandboxBillingAllocation('Sandbox', {
        sandboxId: 'org-abcdef',
        subject: { type: 'user', id: 'user_shared' },
        actor: { type: 'user', id: 'user_shared' },
        sessionId: 'agent_leak',
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('Shared sandbox billing cannot contain session attribution');
  });

  it('rejects isolated-prefixed legacy IDs for shared sandbox classes', () => {
    expect(() =>
      assertSandboxBillingAllocation('Sandbox', {
        sandboxId: 'ses-abcdef__legacy',
        subject: { type: 'user', id: 'user_shared' },
        actor: { type: 'user', id: 'user_shared' },
      })
    ).toThrow('Shared sandbox billing requires a shared sandbox ID');
  });

  it('requires bounded isolated attribution for non-shared sandbox classes', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmall', {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_isolated' },
        actor: { type: 'user', id: 'user_isolated' },
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('Isolated sandbox billing requires session attribution');
  });

  it('rejects unsupported isolated origins at the sandbox RPC boundary', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmall', {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_isolated' },
        actor: { type: 'user', id: 'user_isolated' },
        sessionId: 'agent_1',
        metadata: { origin: 'forged-origin' },
      })
    ).toThrow('Isolated sandbox billing origin is unsupported');
  });

  it('rejects a sandbox ID that does not match the concrete container class', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxDIND', {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('SandboxDIND billing requires a dind- sandbox ID');
  });

  it('skips shadow configuration when a sandbox does not expose the metering RPC', async () => {
    await expect(
      configureSandboxBillingInput({} as SandboxInstance, {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).resolves.toBeUndefined();
  });

  it('does not propagate shadow configuration delivery failures', async () => {
    const configureBilling = vi.fn().mockRejectedValue(new Error('meter unavailable'));
    await expect(
      configureSandboxBillingInput({ configureBilling } as unknown as SandboxInstance, {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).resolves.toBeUndefined();
    expect(configureBilling).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from './persistence/session-metadata.js';
import { buildSandboxBillingInput, SANDBOX_USAGE_SKUS } from './container-usage-context.js';

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
    expect(buildSandboxBillingInput(metadata(identity), 'ses-isolated')).toMatchObject(expected);
  });

  it('keeps isolated metadata bounded and normalizes automation origins', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_security',
        userId: 'user_security',
        orgId: 'org_security',
        createdOnPlatform: 'security-remediation',
      }),
      'crv-isolated'
    );

    expect(input).toMatchObject({
      sessionId: 'agent_security',
      metadata: {
        allocation: 'isolated',
        origin: 'security-remediation',
        repository_provider: 'github',
      },
    });
    expect(JSON.stringify(input)).not.toContain('Kilo-Org/cloud');
  });

  it('omits session, origin, and repository metadata for shared containers', () => {
    const first = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_first',
        userId: 'user_shared',
        orgId: 'org_shared',
        createdOnPlatform: 'security-agent',
      }),
      'org-shared'
    );
    const second = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_second',
        userId: 'user_shared',
        orgId: 'org_shared',
        createdOnPlatform: 'cloud-agent-web',
      }),
      'org-shared'
    );

    expect(first).toEqual(second);
    expect(first).toEqual({
      subject: { type: 'org', id: 'org_shared' },
      actor: { type: 'user', id: 'user_shared' },
      metadata: { allocation: 'shared' },
    });
  });

  it('maps unknown caller-provided origins to other', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_unknown',
        userId: 'user_unknown',
        createdOnPlatform: 'attacker-controlled-value',
      }),
      'dind-isolated'
    );
    expect(input.metadata?.origin).toBe('other');
  });
});

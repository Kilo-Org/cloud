import { describe, expect, it } from 'vitest';
import type { Env } from './types.js';
import { resolveEphemeralSandboxPolicy } from './code-review-ephemeral-sandbox.js';
import type { SessionMetadata } from './persistence/session-metadata.js';

function metadata(input: { createdOnPlatform?: string; orgId?: string }): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'agent_policy',
      userId: 'user_policy',
      orgId: input.orgId,
      createdOnPlatform: input.createdOnPlatform,
    },
    auth: {},
    lifecycle: { version: 1, timestamp: 1 },
  };
}

function env(raw?: string): Pick<Env, 'CODE_REVIEW_EPHEMERAL_SANDBOX_ORG_IDS'> {
  return { CODE_REVIEW_EPHEMERAL_SANDBOX_ORG_IDS: raw };
}

describe('resolveEphemeralSandboxPolicy', () => {
  it('enables exact organization matches and exposes the destroy delay', () => {
    expect(
      resolveEphemeralSandboxPolicy(
        env('org-a,org-b'),
        metadata({ createdOnPlatform: 'code-review', orgId: 'org-b' })
      )
    ).toEqual({ enabled: true, destroyDelayMs: 60_000 });
  });

  it('trims whitespace and ignores empty entries', () => {
    expect(
      resolveEphemeralSandboxPolicy(
        env(' org-a, , org-b '),
        metadata({ createdOnPlatform: 'code-review', orgId: 'org-a' })
      ).enabled
    ).toBe(true);
  });

  it('keeps blank configuration disabled', () => {
    expect(
      resolveEphemeralSandboxPolicy(
        env(' , '),
        metadata({ createdOnPlatform: 'code-review', orgId: 'org-a' })
      ).enabled
    ).toBe(false);
  });

  it('matches wildcard for any Code Reviewer session', () => {
    expect(
      resolveEphemeralSandboxPolicy(env('*'), metadata({ createdOnPlatform: 'code-review' }))
        .enabled
    ).toBe(true);
  });

  it('does not match orgless Code Reviewer sessions without wildcard', () => {
    expect(
      resolveEphemeralSandboxPolicy(env('org-a'), metadata({ createdOnPlatform: 'code-review' }))
        .enabled
    ).toBe(false);
  });

  it('does not enable non-Code Reviewer sessions', () => {
    expect(
      resolveEphemeralSandboxPolicy(
        env('*'),
        metadata({ createdOnPlatform: 'cloud-agent', orgId: 'org-a' })
      ).enabled
    ).toBe(false);
  });
});

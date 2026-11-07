import { describe, expect, it } from 'vitest';
import {
  allowsSubagentSessions,
  isEligibleFirstWorktreeSession,
  isTrustedWorktreeCreateOrigin,
} from './session-registration.js';

describe('stacked agent workspace creation', () => {
  const input: Parameters<typeof isEligibleFirstWorktreeSession>[0] = {
    agent: { model: 'kilo/test-model', mode: 'code' },
    repository: { type: 'github', repo: 'acme/widgets' },
    initialTurn: { type: 'prompt', prompt: 'Implement the next stack layer' },
    parentWorktreeId: 'worktree_11111111-1111-4111-8111-111111111111',
    parentCloudAgentSessionId: 'workspace_parent',
    options: {
      createdOnPlatform: 'cloud-agent',
      operationKey: '22222222-2222-4222-8222-222222222222',
    },
  };
  const context = {
    userId: 'user',
    authToken: 'fixture',
    cloudAgentAuthority: { parentSessionId: 'workspace_parent' },
  } as Parameters<typeof isEligibleFirstWorktreeSession>[1];

  it('registers a workspace for an authorized stacked launch', () => {
    expect(isEligibleFirstWorktreeSession(input, context)).toBe(true);
  });
  it('does not trust a parent link without scoped authority', () => {
    expect(
      isEligibleFirstWorktreeSession(input, { ...context, cloudAgentAuthority: undefined })
    ).toBe(false);
    expect(
      isEligibleFirstWorktreeSession(
        { ...input, parentCloudAgentSessionId: 'workspace_other' },
        context
      )
    ).toBe(false);
  });
  it('registers an independent worker workspace for an orchestrator', () => {
    expect(isEligibleFirstWorktreeSession({ ...input, parentWorktreeId: undefined }, context)).toBe(
      true
    );
  });
  it('requires the creation key and initial turn', () => {
    expect(isEligibleFirstWorktreeSession({ ...input, options: undefined }, context)).toBe(false);
    expect(isEligibleFirstWorktreeSession({ ...input, initialTurn: undefined }, context)).toBe(
      false
    );
    expect(isEligibleFirstWorktreeSession(input, { ...context, botId: 'bot' })).toBe(false);
  });
});

describe('isTrustedWorktreeCreateOrigin', () => {
  it('allows the authenticated browser workspace-create pair', () => {
    expect(isTrustedWorktreeCreateOrigin('browser', 'cloud-agent-web')).toBe(true);
  });

  it('allows the authenticated Agent Manager workspace-create pair', () => {
    expect(isTrustedWorktreeCreateOrigin('agent-manager', 'agent-manager')).toBe(true);
  });

  it.each([
    ['browser', 'agent-manager'],
    ['agent-manager', 'cloud-agent-web'],
    ['browser', 'cloud-agent'],
    ['mobile', 'cloud-agent-web'],
    [undefined, 'agent-manager'],
    ['agent-manager', undefined],
  ])('rejects an untrusted provenance/origin pair (%s, %s)', (provenance, origin) => {
    expect(isTrustedWorktreeCreateOrigin(provenance, origin)).toBe(false);
  });
});

describe('allowsSubagentSessions', () => {
  it.each(['cloud-agent-web', 'desktop', 'agent-manager'])(
    'grants spawn permission to the interactive %s origin',
    createdOnPlatform => {
      expect(allowsSubagentSessions({ options: { createdOnPlatform } })).toBe(true);
    }
  );

  it.each(['cloud-agent', 'slack', 'github', 'code-review', 'security-agent', undefined])(
    'denies spawn permission to the non-interactive %s origin',
    createdOnPlatform => {
      expect(allowsSubagentSessions({ options: { createdOnPlatform } })).toBe(false);
    }
  );

  it('denies spawned child sessions their own spawn permission', () => {
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        parentCloudAgentSessionId: 'workspace_parent',
      })
    ).toBe(false);
  });

  it('denies spawn permission on a shared sandbox', () => {
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        runtime: { sandboxAllocation: 'cloudflare-shared' },
      })
    ).toBe(false);
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        savedSandboxAllocation: 'cloudflare-shared',
      })
    ).toBe(false);
  });

  it('allows spawn permission on an isolated allocation', () => {
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        runtime: { sandboxAllocation: 'cloudflare-containers-standard-3' },
      })
    ).toBe(true);
  });
});

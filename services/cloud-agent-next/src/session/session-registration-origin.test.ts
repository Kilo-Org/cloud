import { describe, expect, it } from 'vitest';
import {
  allowsSubagentSessions,
  isAuthenticatedChildWorktreeCreate,
  isEligibleFirstWorktreeSession,
  isTrustedWorktreeCreateOrigin,
} from './session-registration.js';
import type {
  SessionRegistrationContext,
  SessionRegistrationInput,
} from './session-registration.js';

const ctx = {
  env: {},
  userId: 'usr_test',
  authToken: 'token',
} as unknown as SessionRegistrationContext;

function input(overrides: Partial<SessionRegistrationInput>): SessionRegistrationInput {
  return {
    repository: { type: 'github', repo: 'Kilo-Org/cloud' },
    agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
    options: { clientProvenance: 'agent-manager', createdOnPlatform: 'agent-manager' },
    ...overrides,
  } as SessionRegistrationInput;
}

describe('isEligibleFirstWorktreeSession', () => {
  it('admits the original agent-manager initial-turn create', () => {
    expect(
      isEligibleFirstWorktreeSession(
        input({
          options: {
            clientProvenance: 'agent-manager',
            createdOnPlatform: 'agent-manager',
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          initialTurn: { messageId: 'msg_1' } as never,
        }),
        ctx
      )
    ).toBe(true);
  });

  it('admits an Agent Manager create with no initial turn', () => {
    expect(
      isEligibleFirstWorktreeSession(
        input({
          options: {
            clientProvenance: 'agent-manager',
            createdOnPlatform: 'agent-manager',
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }),
        ctx
      )
    ).toBe(true);
  });

  it('requires a prompt for a browser create', () => {
    expect(
      isEligibleFirstWorktreeSession(
        input({
          options: {
            clientProvenance: 'browser',
            createdOnPlatform: 'cloud-agent-web',
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }),
        ctx
      )
    ).toBe(false);
  });

  it('requires a prompt for an authenticated child create', () => {
    const parentSessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
    expect(
      isEligibleFirstWorktreeSession(
        input({
          parentCloudAgentSessionId: parentSessionId,
          options: {
            clientProvenance: 'agent-manager',
            createdOnPlatform: 'agent-manager',
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }),
        {
          ...ctx,
          cloudAgentAuthority: {
            version: 1 as const,
            ownerId: 'usr_test',
            parentSessionId,
            organizationId: null,
            authorizationId: '12345678-1234-4234-8234-123456789abc',
            expiresAt: 1_800_000_000,
          },
        }
      )
    ).toBe(false);
  });

  it('admits a server-marked clone-only continuation create', () => {
    expect(
      isEligibleFirstWorktreeSession(
        input({
          options: {
            clientProvenance: 'agent-manager',
            createdOnPlatform: 'cloud-agent-web',
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceContinuation: true,
          },
          clone: { cloneFromKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
        }),
        ctx
      )
    ).toBe(true);
  });

  it('does not admit an unmarked clone-only create, preserving clone behavior', () => {
    expect(
      isEligibleFirstWorktreeSession(
        input({
          options: {
            clientProvenance: 'agent-manager',
            createdOnPlatform: 'agent-manager',
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          clone: { cloneFromKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
        }),
        ctx
      )
    ).toBe(false);
  });

  it('does not admit a marked create that still has an initial turn', () => {
    expect(
      isEligibleFirstWorktreeSession(
        input({
          options: {
            clientProvenance: 'agent-manager',
            createdOnPlatform: 'cloud-agent-web',
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceContinuation: true,
          },
          clone: { cloneFromKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
          initialTurn: { messageId: 'msg_1' } as never,
        }),
        ctx
      )
    ).toBe(false);
  });

  it.each([
    { clientProvenance: 'browser', createdOnPlatform: 'cloud-agent-web' },
    { clientProvenance: 'agent-manager', createdOnPlatform: 'agent-manager' },
  ] as const)('rejects a continuation with the wrong provenance or platform: %j', options => {
    expect(
      isEligibleFirstWorktreeSession(
        input({
          options: {
            ...options,
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceContinuation: true,
          },
          clone: { cloneFromKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
        }),
        ctx
      )
    ).toBe(false);
  });

  it('rejects a Cloud-platform create without the server continuation marker', () => {
    expect(
      isEligibleFirstWorktreeSession(
        input({
          options: {
            clientProvenance: 'agent-manager',
            createdOnPlatform: 'cloud-agent-web',
            operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          initialTurn: { messageId: 'msg_1' } as never,
        }),
        ctx
      )
    ).toBe(false);
  });
});

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

describe('isAuthenticatedChildWorktreeCreate', () => {
  const parentSessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
  const authority = {
    version: 1 as const,
    ownerId: 'user-123',
    parentSessionId,
    organizationId: null,
    authorizationId: '12345678-1234-4234-8234-123456789abc',
    expiresAt: 1_800_000_000,
  };

  it.each(['cloud-agent', 'cloud-agent-web', 'agent-manager', 'desktop', undefined])(
    'recognizes a scoped child with inherited origin %s from its authenticated parent authority',
    createdOnPlatform => {
      expect(
        isAuthenticatedChildWorktreeCreate(
          {
            parentCloudAgentSessionId: parentSessionId,
            options: createdOnPlatform === undefined ? undefined : { createdOnPlatform },
          },
          { cloudAgentAuthority: authority }
        )
      ).toBe(true);
    }
  );

  it.each([
    ['missing parent lineage', { options: { createdOnPlatform: 'cloud-agent-web' } }],
    [
      'different parent lineage',
      {
        parentCloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
        options: { createdOnPlatform: 'cloud-agent-web' },
      },
    ],
  ])('rejects %s even with a verified authority', (_label, input) => {
    expect(isAuthenticatedChildWorktreeCreate(input, { cloudAgentAuthority: authority })).toBe(
      false
    );
  });

  it('rejects child lineage without a verified authority', () => {
    expect(
      isAuthenticatedChildWorktreeCreate(
        {
          parentCloudAgentSessionId: parentSessionId,
          options: { createdOnPlatform: 'cloud-agent-web' },
        },
        {}
      )
    ).toBe(false);
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

  it('allows spawn permission on an isolated allocation', () => {
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        runtime: { sandboxAllocation: 'cloudflare-containers-standard-3' },
      })
    ).toBe(true);
  });
});

/**
 * Focused handler tests for the prepareSession operation-ledger admission
 * gate (plan P1-A-08b): `operationKey` + `autoInitiate` propagation to
 * `createSessionWithLedger`, the legacy fallback gates, and the `replayed`
 * output flag.
 *
 * The ledger functions in `session-registration.js` are mocked so the gate
 * logic in the handler is exercised deterministically; the full ladder is
 * covered by `src/session/session-prepare.test.ts`.
 */
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';

import { t } from '../auth.js';
import type { TRPCContext } from '../../types.js';
import { createSessionPrepareHandlers } from './session-prepare.js';

const {
  mergeProfileConfigurationMock,
  assertKiloModelAvailableMock,
  assertBitbucketRepositoryAccessMock,
  assertOrganizationMembershipMock,
  registerNewSessionMock,
  startNewSessionMock,
  createSessionWithLedgerMock,
} = vi.hoisted(() => ({
  mergeProfileConfigurationMock: vi.fn().mockResolvedValue({}),
  assertKiloModelAvailableMock: vi.fn().mockResolvedValue(undefined),
  assertBitbucketRepositoryAccessMock: vi.fn().mockResolvedValue(undefined),
  assertOrganizationMembershipMock: vi.fn().mockResolvedValue(undefined),
  registerNewSessionMock: vi.fn().mockResolvedValue({
    cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    kiloSessionId: 'cli-session-abc123',
    sandboxId: 'sb-test-123',
    sandboxProvider: 'cloudflare',
    initialTurn: {
      type: 'prompt',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      prompt: 'test',
    },
  }),
  startNewSessionMock: vi.fn().mockResolvedValue({
    cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    kiloSessionId: 'cli-session-abc123',
    sandboxId: 'sb-test-123',
    sandboxProvider: 'cloudflare',
    admission: {
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      compatibilityDelivery: 'queued',
    },
  }),
  createSessionWithLedgerMock: vi.fn().mockResolvedValue({
    cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    kiloSessionId: 'cli-session-abc123',
  }),
}));

vi.mock('@kilocode/cloud-agent-profile', async importActual => {
  const actual = await importActual<typeof CloudAgentProfile>();
  return {
    ...actual,
    mergeProfileConfiguration: mergeProfileConfigurationMock,
  };
});

vi.mock('../../db/pg.js', () => ({
  getPgDb: vi.fn(() => ({ mockedDb: true })),
}));

vi.mock('../../model-validation.js', () => ({
  assertKiloModelAvailable: assertKiloModelAvailableMock,
}));

vi.mock('../../session/validate-repository-access.js', () => ({
  assertRepositoryAccessBeforeSessionCreation: assertBitbucketRepositoryAccessMock,
}));

vi.mock('./organization-membership.js', () => ({
  assertOrganizationMembership: assertOrganizationMembershipMock,
}));

vi.mock('../../session/session-registration.js', () => ({
  registerNewSession: registerNewSessionMock,
  startNewSession: startNewSessionMock,
  createSessionWithLedger: createSessionWithLedgerMock,
}));

const handlers = createSessionPrepareHandlers();
const router = t.router({
  prepareSession: handlers.prepareSession,
  updateSession: handlers.updateSession,
});

function createContext(overrides?: {
  userId?: string;
  organizationMembership?: boolean;
}): TRPCContext {
  const headers = new Headers();
  headers.set('x-internal-api-key', 'test-internal-api-secret');
  if (overrides?.organizationMembership === false) {
    assertOrganizationMembershipMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this organization' })
    );
  }
  return {
    userId: overrides?.userId ?? 'test-user-123',
    authToken: 'test-auth-token',
    request: { headers } as Request,
    env: {
      INTERNAL_API_SECRET: 'test-internal-api-secret',
      HYPERDRIVE: {
        connectionString: 'postgres://handler-test',
      },
    } as unknown as TRPCContext['env'],
  } as TRPCContext;
}

const OPERATION_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('prepareSession operation-ledger admission gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mergeProfileConfigurationMock.mockResolvedValue({});
    assertKiloModelAvailableMock.mockResolvedValue(undefined);
    assertBitbucketRepositoryAccessMock.mockResolvedValue(undefined);
    assertOrganizationMembershipMock.mockResolvedValue(undefined);
    registerNewSessionMock.mockResolvedValue({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      sandboxId: 'sb-test-123',
      sandboxProvider: 'cloudflare',
      initialTurn: {
        type: 'prompt',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        prompt: 'test',
      },
    });
    startNewSessionMock.mockResolvedValue({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      sandboxId: 'sb-test-123',
      sandboxProvider: 'cloudflare',
      admission: {
        success: true,
        outcome: 'queued',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        compatibilityDelivery: 'queued',
      },
    });
    createSessionWithLedgerMock.mockResolvedValue({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
    });
  });

  it('propagates operationKey to the ledger create only when autoInitiate is also true', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      createdOnPlatform: 'cloud-agent-web',
    });

    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(1);
    expect(createSessionWithLedgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          operationKey: OPERATION_KEY,
          createdOnPlatform: 'cloud-agent-web',
        }),
      }),
      expect.objectContaining({ userId: 'test-user-123', authToken: 'test-auth-token' }),
      expect.objectContaining({
        billingOrigin: 'cloud-agent-web',
        operationKey: OPERATION_KEY,
        startedAt: expect.any(Number),
      })
    );
    expect(startNewSessionMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
  });

  it('adapts the legacy GitHub integration id into grouped repository identity', async () => {
    const caller = router.createCaller(createContext());
    const githubIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      githubIntegrationId,
      autoInitiate: true,
    });

    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: { type: 'github', repo: 'acme/repo', githubIntegrationId },
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('ignores operationKey when autoInitiate is false and retains legacy registration', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: false,
      operationKey: OPERATION_KEY,
    });

    expect(registerNewSessionMock).toHaveBeenCalledTimes(1);
    expect(registerNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ operationKey: OPERATION_KEY }),
      }),
      expect.objectContaining({ userId: 'test-user-123' }),
      { billingOrigin: undefined }
    );
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('ignores operationKey when autoInitiate is omitted', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      operationKey: OPERATION_KEY,
    });

    expect(registerNewSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('uses grouped startNewSession when autoInitiate is true without an operationKey', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
    });

    expect(startNewSessionMock).toHaveBeenCalledTimes(1);
    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.not.objectContaining({ operationKey: expect.anything() }),
      }),
      expect.objectContaining({ userId: 'test-user-123' }),
      { billingOrigin: undefined }
    );
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
  });

  it('does not reach the ledger when organization membership is rejected', async () => {
    const caller = router.createCaller(createContext({ organizationMembership: false }));
    const organizationId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

    await expect(
      caller.prepareSession({
        prompt: 'Attempt organization attribution',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        kilocodeOrganizationId: organizationId,
        autoInitiate: true,
        operationKey: OPERATION_KEY,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('does not reach the ledger when the model preflight rejects', async () => {
    const caller = router.createCaller(createContext());
    assertKiloModelAvailableMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is not available' })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'missing/model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        operationKey: OPERATION_KEY,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
  });

  it('returns replayed true only when the ledger replays a settled create', async () => {
    createSessionWithLedgerMock.mockResolvedValueOnce({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
    const caller = router.createCaller(createContext());

    const result = await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
    });

    expect(result).toEqual({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
  });

  it('omits the replayed key on a fresh ledger create', async () => {
    const caller = router.createCaller(createContext());

    const result = await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
    });

    expect(result).toEqual({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
    });
    expect(result).not.toHaveProperty('replayed');
  });

  it('propagates the clone source through createSessionWithLedger and replays on a same-key retry', async () => {
    const caller = router.createCaller(createContext());
    const sourceKiloSessionId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';

    await caller.prepareSession({
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      cloneFromKiloSessionId: sourceKiloSessionId,
    });

    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(1);
    expect(createSessionWithLedgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialTurn: undefined,
        clone: { cloneFromKiloSessionId: sourceKiloSessionId },
      }),
      expect.objectContaining({ userId: 'test-user-123' }),
      expect.objectContaining({ operationKey: OPERATION_KEY })
    );
    expect(startNewSessionMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();

    // Same-key retry resumes: the ledger replays the settled clone create.
    createSessionWithLedgerMock.mockResolvedValueOnce({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
    const retry = await caller.prepareSession({
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      cloneFromKiloSessionId: sourceKiloSessionId,
    });

    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(2);
    expect(retry).toEqual({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { transitionAnalysisStartLifecycle } from './analysis-start-lifecycle.js';
import {
  claimRowsForOwner,
  clearOwnerActorResolutionFailure,
  getSecurityFindingById,
  resolveAutoAnalysisActor,
  updateQueueFromPending,
} from './db/queries.js';
import { InsufficientCreditsError, startSecurityAnalysis } from './launch.js';
import { consumeOwnerBatch } from './consumer.js';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));
vi.mock('./analysis-start-lifecycle.js', () => ({
  transitionAnalysisStartLifecycle: vi.fn(),
}));
vi.mock('./db/queries.js', () => ({
  claimRowsForOwner: vi.fn(),
  clearOwnerActorResolutionFailure: vi.fn(),
  getSecurityFindingById: vi.fn(),
  markOwnerActorResolutionFailure: vi.fn(),
  markOwnerCreditFailure: vi.fn(),
  resolveAutoAnalysisActor: vi.fn(),
  updateQueueFromPending: vi.fn(),
}));
vi.mock('./launch.js', () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
  startSecurityAnalysis: vi.fn(),
}));

const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const queueRowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const userId = 'user-123';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getWorkerDb).mockReturnValue({} as never);
  vi.mocked(claimRowsForOwner).mockResolvedValue({
    rows: [
      {
        id: queueRowId,
        finding_id: findingId,
        claim_token: 'scheduled-claim-token',
        attempt_count: 0,
        owned_by_organization_id: null,
        owned_by_user_id: userId,
      },
    ],
    config: {
      analysis_mode: 'auto',
      auto_analysis_enabled: true,
      auto_analysis_min_severity: 'high',
      auto_analysis_include_existing: true,
    },
    isAgentEnabled: true,
    autoAnalysisEnabledAt: '2026-05-19T08:00:00.000Z',
    blocked: false,
  } as never);
  vi.mocked(getSecurityFindingById).mockResolvedValue({
    id: findingId,
    created_at: '2026-05-19T08:01:00.000Z',
    status: 'open',
    severity: 'high',
    repo_full_name: 'kilo/repo',
  } as never);
  vi.mocked(resolveAutoAnalysisActor).mockResolvedValue({
    user: { id: userId, api_token_pepper: null },
    mode: 'owner',
  });
  vi.mocked(clearOwnerActorResolutionFailure).mockResolvedValue(undefined);
  vi.mocked(updateQueueFromPending).mockResolvedValue({ updated: true, attemptCount: 1 });
  vi.mocked(transitionAnalysisStartLifecycle).mockResolvedValue({ transitioned: true });
  vi.mocked(startSecurityAnalysis).mockResolvedValue({ started: true, triageOnly: false });
});

describe('consumeOwnerBatch scheduled lifecycle handoff', () => {
  it('passes the claimed queue row into launch and leaves running settlement to the lifecycle module', async () => {
    const message = {
      body: {
        ownerType: 'user',
        ownerId: userId,
        dispatchId: 'dispatch-123',
        enqueuedAt: '2026-05-19T08:00:00.000Z',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await consumeOwnerBatch(
      { queue: 'security-auto-analysis-owner', messages: [message] } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://example' },
        NEXTAUTH_SECRET: { get: async () => 'next-auth-secret' },
        INTERNAL_API_SECRET: { get: async () => 'internal-api-secret' },
        CALLBACK_TOKEN_SECRET: { get: async () => 'callback-token-secret' },
        GIT_TOKEN_SERVICE: {
          getTokenForRepo: async () => ({ success: true, token: 'github-token' }),
        },
      } as unknown as CloudflareEnv
    );

    expect(startSecurityAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackTokenSecret: 'callback-token-secret',
        lifecycleClaim: {
          source: 'scheduled',
          findingId,
          queueRowId,
          claimToken: 'scheduled-claim-token',
        },
      })
    );
    expect(updateQueueFromPending).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('settles retryable scheduled start failures through lifecycle instead of queue-only updates', async () => {
    vi.mocked(startSecurityAnalysis).mockResolvedValue({
      started: false,
      error: 'prepareSession timed out',
      failureNeedsLifecycleTransition: true,
    });
    const message = {
      body: {
        ownerType: 'user',
        ownerId: userId,
        dispatchId: 'dispatch-456',
        enqueuedAt: '2026-05-19T08:00:00.000Z',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await consumeOwnerBatch(
      { queue: 'security-auto-analysis-owner', messages: [message] } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://example' },
        NEXTAUTH_SECRET: { get: async () => 'next-auth-secret' },
        INTERNAL_API_SECRET: { get: async () => 'internal-api-secret' },
        CALLBACK_TOKEN_SECRET: { get: async () => 'callback-token-secret' },
        GIT_TOKEN_SERVICE: {
          getTokenForRepo: async () => ({ success: true, token: 'github-token' }),
        },
      } as unknown as CloudflareEnv
    );

    expect(transitionAnalysisStartLifecycle).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        claim: {
          source: 'scheduled',
          findingId,
          queueRowId,
          claimToken: 'scheduled-claim-token',
        },
        outcome: expect.objectContaining({
          type: 'start-failed',
          errorMessage: 'prepareSession timed out',
          queueStatus: 'queued',
          failureCode: 'NETWORK_TIMEOUT',
          incrementAttempt: true,
        }),
      })
    );
    expect(updateQueueFromPending).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('requeues credit-gated scheduled starts through lifecycle after running promotion', async () => {
    vi.mocked(startSecurityAnalysis).mockRejectedValue(
      new InsufficientCreditsError('Insufficient credits')
    );
    const message = {
      body: {
        ownerType: 'user',
        ownerId: userId,
        dispatchId: 'dispatch-credit',
        enqueuedAt: '2026-05-19T08:00:00.000Z',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await consumeOwnerBatch(
      { queue: 'security-auto-analysis-owner', messages: [message] } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://example' },
        NEXTAUTH_SECRET: { get: async () => 'next-auth-secret' },
        INTERNAL_API_SECRET: { get: async () => 'internal-api-secret' },
        CALLBACK_TOKEN_SECRET: { get: async () => 'callback-token-secret' },
        GIT_TOKEN_SERVICE: {
          getTokenForRepo: async () => ({ success: true, token: 'github-token' }),
        },
      } as unknown as CloudflareEnv
    );

    expect(transitionAnalysisStartLifecycle).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        claim: {
          source: 'scheduled',
          findingId,
          queueRowId,
          claimToken: 'scheduled-claim-token',
        },
        outcome: expect.objectContaining({
          type: 'start-failed',
          errorMessage: 'Insufficient credits',
          queueStatus: 'queued',
          failureCode: 'INSUFFICIENT_CREDITS',
          incrementAttempt: false,
        }),
      })
    );
    expect(updateQueueFromPending).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('launches unknown severity at the all threshold to match sync-side queue eligibility', async () => {
    vi.mocked(claimRowsForOwner).mockResolvedValue({
      rows: [
        {
          id: queueRowId,
          finding_id: findingId,
          claim_token: 'scheduled-claim-token',
          attempt_count: 0,
          owned_by_organization_id: null,
          owned_by_user_id: userId,
        },
      ],
      config: {
        analysis_mode: 'auto',
        auto_analysis_enabled: true,
        auto_analysis_min_severity: 'all',
        auto_analysis_include_existing: true,
      },
      isAgentEnabled: true,
      autoAnalysisEnabledAt: '2026-05-19T08:00:00.000Z',
      blocked: false,
    } as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: findingId,
      created_at: '2026-05-19T08:01:00.000Z',
      status: 'open',
      severity: 'unexpected',
      repo_full_name: 'kilo/repo',
    } as never);
    const message = {
      body: {
        ownerType: 'user',
        ownerId: userId,
        dispatchId: 'dispatch-unknown-severity',
        enqueuedAt: '2026-05-19T08:00:00.000Z',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await consumeOwnerBatch(
      { queue: 'security-auto-analysis-owner', messages: [message] } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://example' },
        NEXTAUTH_SECRET: { get: async () => 'next-auth-secret' },
        INTERNAL_API_SECRET: { get: async () => 'internal-api-secret' },
        CALLBACK_TOKEN_SECRET: { get: async () => 'callback-token-secret' },
        GIT_TOKEN_SERVICE: {
          getTokenForRepo: async () => ({ success: true, token: 'github-token' }),
        },
      } as unknown as CloudflareEnv
    );

    expect(startSecurityAnalysis).toHaveBeenCalledTimes(1);
    expect(updateQueueFromPending).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });
});

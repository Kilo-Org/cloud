import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { TRPCClientError } from '@trpc/client';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { CreateWorktreeChatInput, CreateWorktreeChatOutput } from './cloud-agent-client';
import type { createWorktreeChat as CreateWorktreeChat } from './worktree-chat';

const UUID = '12345678-1234-4234-9234-123456789abc';
const ORGANIZATION_ID = '9a283301-b75d-4375-a1ba-e319a02e18b7';
const SOURCE_KILO_SESSION_ID = 'ses_12345678901234567890123456';
const SOURCE_WORKSPACE_ID = `workspace_${UUID}` as const;
const WORKTREE_ID = `worktree_${UUID}` as const;

type SourceSession = {
  cloudAgentSessionId: string | null;
  worktreeId: string | null;
};

const mockLimit = jest.fn<(limit: number) => Promise<SourceSession[]>>();
const mockWhere = jest.fn((condition: SQL | undefined) => ({ limit: mockLimit, condition }));
const mockLeftJoin = jest.fn((_table: unknown, condition: SQL | undefined) => ({
  where: mockWhere,
  condition,
}));
const mockFrom = jest.fn(() => ({ leftJoin: mockLeftJoin }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));
const mockWorkerCreateWorktreeChat =
  jest.fn<(input: CreateWorktreeChatInput) => Promise<CreateWorktreeChatOutput>>();
const mockCreateCloudAgentNextClient = jest.fn(() => ({
  createWorktreeChat: mockWorkerCreateWorktreeChat,
}));
const mockGenerateCloudAgentToken = jest.fn(() => 'cloud-agent-token');

jest.mock('@/lib/drizzle', () => ({
  db: { select: mockSelect },
}));

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: mockGenerateCloudAgentToken,
}));

jest.mock('./cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
}));

let createWorktreeChat: typeof CreateWorktreeChat;

function compileCondition(condition: SQL | undefined) {
  if (!condition) {
    throw new Error('Expected a SQL condition');
  }

  return new PgDialect().sqlToQuery(condition);
}

beforeAll(async () => {
  ({ createWorktreeChat } = await import('./worktree-chat'));
});

describe('createWorktreeChat', () => {
  const user = { id: 'oauth/github|owner', is_admin: false } as User;
  const result = {
    kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
    cloudAgentSessionId: SOURCE_WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    replayed: false,
  } satisfies CreateWorktreeChatOutput;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLimit.mockResolvedValue([
      { cloudAgentSessionId: SOURCE_WORKSPACE_ID, worktreeId: WORKTREE_ID },
    ]);
    mockWorkerCreateWorktreeChat.mockResolvedValue(result);
  });

  it('authorizes exact personal ownership, preserves arbitrary user IDs, and sends trusted browser provenance', async () => {
    await expect(
      createWorktreeChat({
        user,
        sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
        operationKey: UUID,
      })
    ).resolves.toEqual(result);

    const where = compileCondition(mockWhere.mock.calls[0]?.[0]);
    expect(where.sql).toContain('"organization_id" is null');
    expect(where.params).toEqual([SOURCE_KILO_SESSION_ID, user.id]);
    expect(mockWorkerCreateWorktreeChat).toHaveBeenCalledWith({
      sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
      sourceCloudAgentSessionId: SOURCE_WORKSPACE_ID,
      operationKey: UUID,
      clientProvenance: 'browser',
    });
  });

  it('requires the owner and current membership in the exact organization', async () => {
    await expect(
      createWorktreeChat({
        user,
        sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
        operationKey: UUID,
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toEqual(result);

    const membership = compileCondition(mockLeftJoin.mock.calls[0]?.[1]);
    const where = compileCondition(mockWhere.mock.calls[0]?.[0]);
    expect(membership.sql).toContain('"organization_memberships"."organization_id"');
    expect(membership.params).toEqual([user.id]);
    expect(where.sql).toContain('"organization_memberships"."id" is not null');
    expect(where.params).toEqual([SOURCE_KILO_SESSION_ID, user.id, ORGANIZATION_ID]);
    expect(mockWorkerCreateWorktreeChat).toHaveBeenCalledWith({
      sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
      sourceCloudAgentSessionId: SOURCE_WORKSPACE_ID,
      operationKey: UUID,
      kilocodeOrganizationId: ORGANIZATION_ID,
      clientProvenance: 'browser',
    });
  });

  it.each([
    {
      description: 'another personal owner',
      userId: 'oauth/github|attacker',
      organizationId: undefined,
    },
    {
      description: 'a same-organization nonowner',
      userId: 'oauth/github|coworker',
      organizationId: ORGANIZATION_ID,
    },
    {
      description: 'the wrong organization context',
      userId: user.id,
      organizationId: '22222222-2222-4222-8222-222222222222',
    },
    {
      description: 'a revoked organization member',
      userId: user.id,
      organizationId: ORGANIZATION_ID,
    },
  ])('denies $description without contacting the Worker', async ({ userId, organizationId }) => {
    mockLimit.mockResolvedValueOnce([]);
    const requestUser = { ...user, id: userId };

    await expect(
      createWorktreeChat({
        user: requestUser,
        sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
        operationKey: UUID,
        ...(organizationId ? { organizationId } : {}),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const where = compileCondition(mockWhere.mock.calls[0]?.[0]);
    expect(where.params).toContain(userId);
    if (organizationId) {
      expect(where.params).toContain(organizationId);
      expect(where.sql).toContain('"organization_memberships"."id" is not null');
    }
    expect(mockGenerateCloudAgentToken).not.toHaveBeenCalled();
    expect(mockWorkerCreateWorktreeChat).not.toHaveBeenCalled();
  });

  it.each([
    { cloudAgentSessionId: null, worktreeId: WORKTREE_ID },
    { cloudAgentSessionId: `agent_${UUID}`, worktreeId: WORKTREE_ID },
    { cloudAgentSessionId: 'workspace_invalid', worktreeId: WORKTREE_ID },
    { cloudAgentSessionId: SOURCE_WORKSPACE_ID, worktreeId: null },
    { cloudAgentSessionId: SOURCE_WORKSPACE_ID, worktreeId: 'worktree_invalid' },
  ])('rejects an ineligible source %j before contacting the Worker', async source => {
    mockLimit.mockResolvedValueOnce([source]);

    await expect(
      createWorktreeChat({
        user,
        sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
        operationKey: UUID,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockWorkerCreateWorktreeChat).not.toHaveBeenCalled();
  });

  it('rejects native mobile before querying the source or trusting browser provenance', async () => {
    await expect(
      createWorktreeChat({
        user,
        headersList: new Headers({ 'x-kilo-client': 'mobile' }),
        sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
        operationKey: UUID,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockWorkerCreateWorktreeChat).not.toHaveBeenCalled();
  });

  it.each([
    ['BAD_REQUEST', 'worktree_source_not_eligible', 'worktree_source_not_eligible'],
    ['FORBIDDEN', 'Session access denied', 'Worktree chat request failed'],
    ['NOT_FOUND', 'Private checkout /srv/secret', 'Worktree chat request failed'],
    ['CONFLICT', 'creation_in_progress', 'creation_in_progress'],
    ['CONFLICT', 'operation_key_reuse_mismatch', 'operation_key_reuse_mismatch'],
    ['SERVICE_UNAVAILABLE', 'Bearer sensitive-worker-token', 'Worktree chat request failed'],
    [
      'INTERNAL_SERVER_ERROR',
      'worktree_chat_registration_failed',
      'worktree_chat_registration_failed',
    ],
  ] as const)(
    'preserves safe upstream %s semantics without leaking details',
    async (code, message, expectedMessage) => {
      const error = new TRPCClientError(message, {
        result: {
          error: {
            code: -32000,
            message,
            data: { code },
          },
        },
      });
      mockWorkerCreateWorktreeChat.mockRejectedValueOnce(error);

      await expect(
        createWorktreeChat({
          user,
          sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
          operationKey: UUID,
        })
      ).rejects.toMatchObject({ code, message: expectedMessage });
    }
  );

  it('maps a known upstream HTTP status when no tRPC code is available', async () => {
    const error = new TRPCClientError('internal detail token=private', {
      result: {
        error: {
          code: -32000,
          message: 'internal detail token=private',
          data: { httpStatus: 409 },
        },
      },
    });
    mockWorkerCreateWorktreeChat.mockRejectedValueOnce(error);

    await expect(
      createWorktreeChat({
        user,
        sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
        operationKey: UUID,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Worktree chat request failed' });
  });

  it('converts ambiguous transport failures into sanitized retryable service errors', async () => {
    mockWorkerCreateWorktreeChat.mockRejectedValueOnce(
      new Error('Worker unavailable Authorization: Bearer private-token')
    );

    await expect(
      createWorktreeChat({
        user,
        sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
        operationKey: UUID,
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Worktree chat service is unavailable',
    });
  });
});

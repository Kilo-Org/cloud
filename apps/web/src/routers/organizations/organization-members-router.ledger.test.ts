/**
 * @jest-environment node
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type { OperationLedgerRow } from '@kilocode/db/schema';
import type * as organizationsModule from '@/lib/organizations/organizations';
import type * as auditLogModule from '@/lib/organizations/organization-audit-logs';
import type * as userModule from '@/lib/user';
import type * as lifecycleServiceModule from '@/lib/mcp-gateway/lifecycle-service';
import type * as instanceRegistryModule from '@/lib/kiloclaw/instance-registry';

// P1-A-08e: the organization operation ledger. The role-change and member
// removal mutations admit / settle through `@kilocode/db/operation-ledger`,
// read memberships back through `@/lib/drizzle`, and write the success audit
// + settle + outbox inside one transaction. All are mocked so the ledger tests
// assert admission, replay, failed-helper settlement, atomicity, and read-back
// takeover orchestration without a database.
const mockAdmitOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSettleOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: (...args: unknown[]) => mockAdmitOperation(...args),
  settleOperation: (...args: unknown[]) => mockSettleOperation(...args),
}));

const mockUpdateUserRoleInOrganization = jest.fn() as jest.MockedFunction<
  typeof organizationsModule.updateUserRoleInOrganization
>;
const mockRemoveUserFromOrganization = jest.fn() as jest.MockedFunction<
  typeof organizationsModule.removeUserFromOrganization
>;
const mockCreateAuditLog = jest.fn() as jest.MockedFunction<typeof auditLogModule.createAuditLog>;
const mockFindUserById = jest.fn() as jest.MockedFunction<typeof userModule.findUserById>;
const mockUpdateOrganizationUserLimit = jest.fn();
const mockRevokeGatewayStateForOrganizationMember = jest.fn() as jest.MockedFunction<
  typeof lifecycleServiceModule.revokeGatewayStateForOrganizationMember
>;
const mockDestroyOrgInstancesForUser = jest.fn() as jest.MockedFunction<
  typeof instanceRegistryModule.destroyOrgInstancesForUser
>;

jest.mock('@/lib/organizations/organizations', () => ({
  updateUserRoleInOrganization: mockUpdateUserRoleInOrganization,
  removeUserFromOrganization: mockRemoveUserFromOrganization,
  getOrganizationById: jest.fn(),
  getOrganizationMembers: jest.fn(),
  addUserToOrganization: jest.fn(),
  inviteUserToOrganization: jest.fn(),
  getAcceptInviteUrl: jest.fn(),
}));
jest.mock('@/lib/organizations/organization-usage', () => ({
  updateOrganizationUserLimit: mockUpdateOrganizationUserLimit,
}));
jest.mock('@/lib/organizations/organization-audit-logs', () => ({
  createAuditLog: mockCreateAuditLog,
}));
jest.mock('@/lib/user', () => ({ findUserById: mockFindUserById }));
jest.mock('@/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest
    .fn<(organizationId: string) => Promise<{ isReadOnly: boolean; daysRemaining: number }>>()
    .mockResolvedValue({ isReadOnly: false, daysRemaining: Infinity }),
}));
jest.mock('@/lib/mcp-gateway/lifecycle-service', () => ({
  revokeGatewayStateForOrganizationMember: mockRevokeGatewayStateForOrganizationMember,
}));
jest.mock('@/lib/kiloclaw/instance-registry', () => ({
  destroyOrgInstancesForUser: mockDestroyOrgInstancesForUser,
}));
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({ destroy: jest.fn() })),
}));

// The router reads memberships back through `db` from `@/lib/drizzle`. The mock
// is static (the router is imported once) but its per-query results are driven
// by a mutable state object that each test configures.
const mockDbState = {
  targetMember: [] as unknown[],
  roleReadBack: [] as unknown[],
  removeTargetMember: [] as unknown[],
  memberReadBack: [] as unknown[],
};
const tx = { __tx: true };
const mockDb = {
  select: jest.fn<() => unknown>(),
  transaction: jest.fn<(callback: (tx: unknown) => unknown) => unknown>(),
};

jest.mock('@/lib/drizzle', () => ({ db: mockDb }));

let createCaller: any;
let caller: any;

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ownerUser = {
  id: 'owner-user-1',
  google_user_email: 'owner@example.com',
  google_user_name: 'Owner Example',
  is_admin: true,
} as never;

beforeAll(async () => {
  const mod = await import('./organization-members-router');
  createCaller = createCallerFactory(mod.organizationsMembersRouter);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDbState.targetMember = [];
  mockDbState.roleReadBack = [];
  mockDbState.removeTargetMember = [];
  mockDbState.memberReadBack = [];
  mockDb.select.mockImplementation(() => ({
    from: () => ({
      where: () => {
        const query = {
          limit: async () =>
            mockDbState.roleReadBack.length > 0
              ? mockDbState.roleReadBack
              : mockDbState.memberReadBack,
          then: (resolve: (value: unknown) => void) =>
            resolve(
              mockDbState.targetMember.length > 0
                ? mockDbState.targetMember
                : mockDbState.removeTargetMember
            ),
        };
        return query;
      },
      innerJoin: () => ({
        where: () => ({
          then: (resolve: (value: unknown) => void) => resolve(mockDbState.removeTargetMember),
        }),
      }),
    }),
  }));
  mockDb.transaction.mockImplementation(async (callback: (value: unknown) => unknown) =>
    callback(tx)
  );
  mockSettleOperation.mockResolvedValue({ settled: true });
  mockUpdateUserRoleInOrganization.mockResolvedValue({ success: true, updated: 'membership' });
  mockRemoveUserFromOrganization.mockResolvedValue({ rowCount: 1 });
  mockFindUserById.mockResolvedValue({ google_user_email: 'member@example.com' } as never);
  mockDestroyOrgInstancesForUser.mockResolvedValue([] as never);
  mockRevokeGatewayStateForOrganizationMember.mockResolvedValue(undefined);
  caller = createCaller({ user: ownerUser });
});

function ledgerRow(overrides: Partial<OperationLedgerRow> = {}): OperationLedgerRow {
  return {
    id: 'org-ledger-row-id',
    operation_key: 'org-op-key-1',
    domain: 'organization',
    intent: 'member_role_change',
    kilo_user_id: 'owner-user-1',
    organization_id: ORG_ID,
    resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}:role:member`,
    provider_ref: null,
    taxonomy: 'reconcile-first',
    status: 'admitted',
    outcome_code: null,
    canonical_result: null,
    admitted_at: '2026-06-17T10:00:00.000Z',
    settled_at: null,
    lease_expires_at: '2026-06-17T10:02:00.000Z',
    expires_at: '2026-07-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('organizations members ledger (P1-A-08e)', () => {
  describe('update: role-change ledger', () => {
    const input = {
      organizationId: ORG_ID,
      memberId: MEMBER_ID,
      role: 'member' as const,
      operationKey: 'org-op-key-1',
    };

    it('admits before the helper and settles completed with audit + outbox in one transaction', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
      mockDbState.targetMember = [{ role: 'owner' }];

      const result = await caller.update(input);

      expect(result).toEqual({ success: true, updated: 'role and limit' });
      expect(mockAdmitOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'owner-user-1',
          orgId: ORG_ID,
          domain: 'organization',
          intent: 'member_role_change',
          operationKey: 'org-op-key-1',
          resourceKey: `organization:${ORG_ID}:member:${MEMBER_ID}:role:member`,
          taxonomy: 'reconcile-first',
          leaseSeconds: 120,
        })
      );
      expect(mockUpdateUserRoleInOrganization).toHaveBeenCalledWith(ORG_ID, MEMBER_ID, 'member');

      // The success audit log and the terminal settle share one transaction.
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'organization.member.change_role',
          organization_id: ORG_ID,
          tx,
        })
      );
      expect(mockSettleOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'completed',
          outcomeCode: 'ok',
          canonicalResult: { updated: 'role and limit' },
        })
      );
      const settleCall = mockSettleOperation.mock.calls[0]?.[1] as {
        outboxEvent: { eventName: string; properties: Record<string, unknown> };
      };
      expect(settleCall?.outboxEvent).toMatchObject({
        eventName: 'organization_write_settled',
        distinctId: 'owner@example.com',
        properties: {
          source: 'web',
          surface: 'organization',
          phase: 'terminal',
          intent: 'member_role_change',
          outcome: 'completed',
        },
      });
    });

    it('settles the row failed without success audit or outbox when the helper fails', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
      mockUpdateUserRoleInOrganization.mockResolvedValue({ success: false, updated: 'none' });
      mockDbState.targetMember = [{ role: 'owner' }];

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Failed to update user role',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'role_change_failed',
        })
      );
      const settleCall = mockSettleOperation.mock.calls[0]?.[1] as {
        outboxEvent: { eventName: string; properties: Record<string, unknown> };
      };
      expect(settleCall?.outboxEvent).toMatchObject({
        eventName: 'organization_write_settled',
        properties: { intent: 'member_role_change', outcome: 'failed' },
      });
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('replays a settled duplicate without re-running the helper or re-settling', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_settled',
        row: ledgerRow({
          status: 'completed',
          canonical_result: { updated: 'role and limit' },
        }),
      });
      mockDbState.targetMember = [{ role: 'owner' }];

      const result = await caller.update(input);

      expect(result).toEqual({ success: true, updated: 'role and limit', replayed: true });
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });

    it('replays a settled role change even when the member was removed after the original success', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_settled',
        row: ledgerRow({
          status: 'completed',
          canonical_result: { updated: 'role and limit' },
        }),
      });
      // The member is already gone. Keyed role changes admit BEFORE the
      // mutable membership lookup, so the settled replay must not be blocked
      // by the NOT_FOUND precondition.
      mockDbState.targetMember = [];

      const result = await caller.update(input);

      expect(result).toEqual({ success: true, updated: 'role and limit', replayed: true });
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });

    it('settles the row failed when a first-time keyed role change finds the member already gone', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
      mockDbState.targetMember = [];

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'User is not a member of this organization',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'member_absent',
        })
      );
      // The ledger admission runs BEFORE the membership lookup: the absent
      // member settles the row `failed` instead of being rejected before the
      // keyed path could ever admit.
      expect(mockAdmitOperation.mock.invocationCallOrder[0]).toBeLessThan(
        mockSettleOperation.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
      );
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });

    it('conflicts on an in-flight duplicate instead of re-running the helper', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_in_flight',
        row: ledgerRow(),
      });
      mockDbState.targetMember = [{ role: 'owner' }];

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'operation_in_progress',
      });
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
    });

    it('rejects cross-intent key reuse before honoring any outcome', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: ledgerRow({ intent: 'member_remove' }),
      });
      mockDbState.targetMember = [{ role: 'owner' }];

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'operation_key_reuse_mismatch',
      });
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
    });
  });

  describe('update: read-back takeover repair for role change', () => {
    const input = {
      organizationId: ORG_ID,
      memberId: MEMBER_ID,
      role: 'member' as const,
      operationKey: 'org-op-key-1',
    };

    it('settles completed and replays when the read-back already shows the target role', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'takeover', row: ledgerRow() });
      mockDbState.targetMember = [{ role: 'member' }];
      mockDbState.roleReadBack = [{ role: 'member' }];

      const result = await caller.update(input);

      expect(result).toEqual({ success: true, updated: 'role and limit', replayed: true });
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.member.change_role', tx })
      );
      expect(mockSettleOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ rowId: 'org-ledger-row-id', status: 'completed' })
      );
    });

    it('completes the record and replays when the read-back shows the member removed after the original success', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'takeover', row: ledgerRow() });
      mockDbState.targetMember = [{ role: 'member' }];
      // The member is gone at retry time. The keyed path reads membership only
      // after admission and settles `failed` when the member is absent on first
      // execution, so an absent read-back means the original success committed
      // and the member was REMOVED later: complete as completed and replay
      // instead of failing the retry with NOT_FOUND.
      mockDbState.roleReadBack = [];

      const result = await caller.update(input);

      expect(result).toEqual({ success: true, updated: 'role and limit', replayed: true });
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.member.change_role', tx })
      );
      expect(mockSettleOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ rowId: 'org-ledger-row-id', status: 'completed' })
      );
      const settleCall = mockSettleOperation.mock.calls[0]?.[1] as {
        outboxEvent?: { eventName: string; properties: { outcome: string } };
      };
      expect(settleCall?.outboxEvent).toMatchObject({
        eventName: 'organization_write_settled',
        properties: { intent: 'member_role_change', outcome: 'completed' },
      });
    });

    it('re-runs the helper under the same row when the read-back shows a different role', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'takeover', row: ledgerRow() });
      mockDbState.targetMember = [{ role: 'owner' }];
      mockDbState.roleReadBack = [{ role: 'owner' }];

      const result = await caller.update(input);

      expect(mockUpdateUserRoleInOrganization).toHaveBeenCalledWith(ORG_ID, MEMBER_ID, 'member');
      expect(result).toEqual({ success: true, updated: 'role and limit' });
      expect(mockSettleOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ rowId: 'org-ledger-row-id', status: 'completed' })
      );
    });
  });

  describe('remove: member-removal ledger', () => {
    const input = {
      organizationId: ORG_ID,
      memberId: MEMBER_ID,
      operationKey: 'org-op-key-1',
    };

    it('admits before the helper and settles completed with audit + outbox in one transaction', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: ledgerRow({
          intent: 'member_remove',
          resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
        }),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];

      const result = await caller.remove(input);

      expect(result).toEqual({ success: true, updated: MEMBER_ID });
      expect(mockAdmitOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          domain: 'organization',
          intent: 'member_remove',
          resourceKey: `organization:${ORG_ID}:member:${MEMBER_ID}`,
        })
      );
      expect(mockRemoveUserFromOrganization).toHaveBeenCalledWith(
        ORG_ID,
        MEMBER_ID,
        'owner-user-1'
      );
      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'organization.member.remove',
          organization_id: ORG_ID,
          tx,
        })
      );
      expect(mockSettleOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'completed',
          outcomeCode: 'ok',
          canonicalResult: { updated: MEMBER_ID },
        })
      );
      const settleCall = mockSettleOperation.mock.calls[0]?.[1] as {
        outboxEvent: { eventName: string; properties: Record<string, unknown> };
      };
      expect(settleCall?.outboxEvent).toMatchObject({
        eventName: 'organization_write_settled',
        properties: { intent: 'member_remove', outcome: 'completed' },
      });
      expect(mockRevokeGatewayStateForOrganizationMember).toHaveBeenCalledWith(
        expect.anything(),
        ORG_ID,
        MEMBER_ID
      );
    });

    it('settles the row failed without success audit or outbox when the helper removes nothing', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: ledgerRow({
          intent: 'member_remove',
          resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
        }),
      });
      mockRemoveUserFromOrganization.mockResolvedValue({ rowCount: 0 });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Failed to remove user from organization',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'member_absent',
        })
      );
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
    });

    it('replays a settled duplicate without re-running the helper, even when the member is already gone', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_settled',
        row: ledgerRow({
          intent: 'member_remove',
          resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
          status: 'completed',
          canonical_result: { updated: MEMBER_ID },
        }),
      });
      // The member is already removed: the missing-member precondition must not
      // block the settled replay (admission runs before the precondition).
      mockDbState.removeTargetMember = [];

      const result = await caller.remove(input);

      expect(result).toEqual({ success: true, updated: MEMBER_ID, replayed: true });
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });

    it('conflicts on an in-flight duplicate instead of re-running the helper', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_in_flight',
        row: ledgerRow({
          intent: 'member_remove',
          resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
        }),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'operation_in_progress',
      });
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
    });

    it('settles the row failed when a first-time removal finds the member already gone', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: ledgerRow({
          intent: 'member_remove',
          resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
        }),
      });
      mockDbState.removeTargetMember = [];

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'User is not a member of this organization',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'member_absent',
        })
      );
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });

    it('settles the row failed when the target is a service account (bot)', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: ledgerRow({
          intent: 'member_remove',
          resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
        }),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: true }];

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Service account users cannot be removed',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'bot_removal_refused',
        })
      );
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });
  });

  describe('remove: read-back takeover repair for member removal', () => {
    const input = {
      organizationId: ORG_ID,
      memberId: MEMBER_ID,
      operationKey: 'org-op-key-1',
    };

    it('completes the record and replays when the read-back shows the member already gone', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'takeover',
        row: ledgerRow({
          intent: 'member_remove',
          resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
        }),
      });
      // The member is already removed when the retry arrives (lost response
      // after the first removal committed): the missing-member precondition
      // must not run before the ledger — the takeover repair handles it.
      mockDbState.removeTargetMember = [];
      mockDbState.memberReadBack = [];

      const result = await caller.remove(input);

      expect(result).toEqual({ success: true, updated: MEMBER_ID, replayed: true });
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.member.remove', tx })
      );
      expect(mockSettleOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ rowId: 'org-ledger-row-id', status: 'completed' })
      );
      expect(mockRevokeGatewayStateForOrganizationMember).toHaveBeenCalledWith(
        expect.anything(),
        ORG_ID,
        MEMBER_ID
      );
    });

    it('re-runs the helper under the same row when the read-back still shows the member', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'takeover',
        row: ledgerRow({
          intent: 'member_remove',
          resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
        }),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];
      mockDbState.memberReadBack = [{ id: MEMBER_ID }];

      const result = await caller.remove(input);

      expect(mockRemoveUserFromOrganization).toHaveBeenCalledWith(
        ORG_ID,
        MEMBER_ID,
        'owner-user-1'
      );
      expect(result).toEqual({ success: true, updated: MEMBER_ID, replayed: true });
      expect(mockSettleOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ rowId: 'org-ledger-row-id', status: 'completed' })
      );
    });
  });
});

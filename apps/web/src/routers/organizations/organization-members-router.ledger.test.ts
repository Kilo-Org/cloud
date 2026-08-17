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
import type * as organizationsUtilsModule from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';

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

// The router re-checks organization access inside the keyed mutation bodies
// AFTER admission. The procedure middleware keeps the REAL
// `ensureOrganizationAccess` (it closes over the module-internal binding), so
// existing tests run unchanged; the body-level re-check uses the mock so the
// tests can drive a definitive authorization rejection after admission.
const mockEnsureOrganizationAccess = jest.fn() as jest.MockedFunction<
  typeof organizationsUtilsModule.ensureOrganizationAccess
>;
jest.mock('@/routers/organizations/utils', () => ({
  ...jest.requireActual<typeof organizationsUtilsModule>('@/routers/organizations/utils'),
  ensureOrganizationAccess: mockEnsureOrganizationAccess,
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
  markerUpdateValues: null as Record<string, unknown> | null,
};
const tx = { __tx: true };
const mockDb = {
  select: jest.fn<() => unknown>(),
  update: jest.fn<() => unknown>(),
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
  mockDbState.markerUpdateValues = null;
  mockDb.update.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => {
      mockDbState.markerUpdateValues = values;
      return {
        where: jest.fn<() => Promise<{ rowCount: number }>>().mockResolvedValue({ rowCount: 1 }),
      };
    },
  }));
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
        where: () => {
          const query = {
            limit: async () =>
              mockDbState.removeTargetMember.length > 0
                ? mockDbState.removeTargetMember
                : mockDbState.memberReadBack,
            then: (resolve: (value: unknown) => void) => resolve(mockDbState.removeTargetMember),
          };
          return query;
        },
      }),
    }),
  }));
  mockDb.transaction.mockImplementation(async (callback: (value: unknown) => unknown) =>
    callback(tx)
  );
  mockSettleOperation.mockResolvedValue({ settled: true });
  // The owner caller passes the body-level access re-check by default; tests
  // that exercise authorization rejections override this per test.
  mockEnsureOrganizationAccess.mockResolvedValue('owner');
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

/** `ledgerRow` for the member-removal intent. */
function removeRow(overrides: Partial<OperationLedgerRow> = {}): OperationLedgerRow {
  return ledgerRow({
    intent: 'member_remove',
    resource_key: `organization:${ORG_ID}:member:${MEMBER_ID}`,
    ...overrides,
  });
}

/** The outbox event of the first settle call. */
function firstSettleOutboxEvent(): { eventName: string; properties: Record<string, unknown> } {
  return (
    mockSettleOperation.mock.calls[0]?.[1] as {
      outboxEvent: { eventName: string; properties: Record<string, unknown> };
    }
  )?.outboxEvent;
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
      expect(firstSettleOutboxEvent()).toMatchObject({
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
      expect(firstSettleOutboxEvent()).toMatchObject({
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

    it('settles the row failed when the access re-check rejects a keyed role change', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
      mockDbState.targetMember = [{ role: 'member' }];
      mockEnsureOrganizationAccess.mockRejectedValue(
        new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have the required organizational role to access this feature',
        })
      );

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      });

      // The definitive authorization rejection settles the admitted row failed
      // before the existing error returns.
      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'authorization_failed',
        })
      );
      expect(firstSettleOutboxEvent()).toMatchObject({
        eventName: 'organization_write_settled',
        properties: { intent: 'member_role_change', outcome: 'failed' },
      });
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('settles the row failed when the owner-authority check rejects a keyed role change', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
      mockDbState.targetMember = [{ role: 'owner' }];
      mockEnsureOrganizationAccess.mockResolvedValue('admin');

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only an organization owner can manage owners',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'authorization_failed',
        })
      );
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('leaves the row retryable when the admitted access re-check hits an operational error', async () => {
      // An operational database error from the access re-check is NOT a
      // definitive authorization rejection: it must be rethrown untouched and
      // must not settle the admitted row as a terminal authorization failure.
      mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
      mockDbState.targetMember = [{ role: 'member' }];
      mockEnsureOrganizationAccess.mockRejectedValue(new Error('database connection failed'));

      await expect(caller.update(input)).rejects.toThrow('database connection failed');

      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('replays a settled failed role change as non-retryable instead of taking over', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_settled',
        row: ledgerRow({ status: 'failed', outcome_code: 'authorization_failed' }),
      });
      mockDbState.targetMember = [{ role: 'owner' }];

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This action did not complete. Please try again.',
      });
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockSettleOperation).not.toHaveBeenCalled();
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
      expect(firstSettleOutboxEvent()).toMatchObject({
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

    it('settles the row failed when the takeover access re-check rejects a role change', async () => {
      // A takeover retry must not bypass the access re-check: a definitive
      // authorization rejection settles the row `failed` before the original
      // typed error returns, so a later same-key retry replays the rejection
      // instead of taking over again.
      mockAdmitOperation.mockResolvedValue({ admission: 'takeover', row: ledgerRow() });
      mockDbState.roleReadBack = [{ role: 'owner' }];
      mockEnsureOrganizationAccess.mockRejectedValue(
        new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have the required organizational role to access this feature',
        })
      );

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'authorization_failed',
        })
      );
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('settles the row failed when the takeover owner-authority check rejects a role change', async () => {
      mockAdmitOperation.mockResolvedValue({ admission: 'takeover', row: ledgerRow() });
      mockDbState.roleReadBack = [{ role: 'owner' }];
      mockEnsureOrganizationAccess.mockResolvedValue('admin');

      await expect(caller.update(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only an organization owner can manage owners',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'authorization_failed',
        })
      );
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('leaves the row retryable when the takeover access re-check hits an operational error', async () => {
      // An operational database error during the takeover re-check is rethrown
      // untouched and never settles the row: the retry stays retryable.
      mockAdmitOperation.mockResolvedValue({ admission: 'takeover', row: ledgerRow() });
      mockDbState.roleReadBack = [{ role: 'owner' }];
      mockEnsureOrganizationAccess.mockRejectedValue(new Error('database connection failed'));

      await expect(caller.update(input)).rejects.toThrow('database connection failed');

      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockUpdateUserRoleInOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
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
        row: removeRow(),
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
          canonicalResult: { updated: MEMBER_ID, cleanup: 'pending' },
        })
      );
      expect(firstSettleOutboxEvent()).toMatchObject({
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
        row: removeRow(),
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
        row: removeRow({
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

    it('retries gateway revocation on a same-key replay after the first cleanup failed', async () => {
      // First attempt: the removal commits and settles completed, then the
      // gateway revocation fails. The settle ran before the cleanup, so the
      // settled row records the cleanup as pending.
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: removeRow(),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];
      mockRevokeGatewayStateForOrganizationMember.mockRejectedValueOnce(
        new Error('gateway revocation failed')
      );

      await expect(caller.remove(input)).rejects.toThrow('gateway revocation failed');

      const settleCall = mockSettleOperation.mock.calls[0]?.[1] as {
        canonicalResult: { updated: string; cleanup: string };
      };
      expect(settleCall?.canonicalResult).toEqual({ updated: MEMBER_ID, cleanup: 'pending' });
      expect(mockRevokeGatewayStateForOrganizationMember).toHaveBeenCalledTimes(1);

      // Replay: the row is settled completed but its cleanup was never
      // recorded complete, so the replay retries the cleanup instead of
      // replaying a false success.
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_settled',
        row: removeRow({
          status: 'completed',
          canonical_result: { updated: MEMBER_ID, cleanup: 'pending' },
        }),
      });

      const result = await caller.remove(input);

      expect(result).toEqual({ success: true, updated: MEMBER_ID, replayed: true });
      expect(mockRevokeGatewayStateForOrganizationMember).toHaveBeenCalledTimes(2);
      expect(mockRemoveUserFromOrganization).toHaveBeenCalledTimes(1);
      expect(mockSettleOperation).toHaveBeenCalledTimes(1);
      expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
      // The successful replay records the cleanup as complete in the row.
      expect(mockDbState.markerUpdateValues).toEqual({
        canonical_result: { updated: MEMBER_ID, cleanup: 'complete' },
      });
    });

    it('replays a settled member removal without re-running cleanup when cleanup is already complete', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_settled',
        row: removeRow({
          status: 'completed',
          canonical_result: { updated: MEMBER_ID, cleanup: 'complete' },
        }),
      });
      mockDbState.removeTargetMember = [];

      const result = await caller.remove(input);

      expect(result).toEqual({ success: true, updated: MEMBER_ID, replayed: true });
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
      expect(mockDestroyOrgInstancesForUser).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });

    it('conflicts on an in-flight duplicate instead of re-running the helper', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_in_flight',
        row: removeRow(),
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
        row: removeRow(),
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
        row: removeRow(),
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

    it('settles the row failed when the access re-check rejects a keyed removal', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: removeRow(),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];
      mockEnsureOrganizationAccess.mockRejectedValue(
        new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have the required organizational role to access this feature',
        })
      );

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      });

      // The definitive authorization rejection settles the admitted row failed
      // before the existing error returns.
      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'authorization_failed',
        })
      );
      expect(firstSettleOutboxEvent()).toMatchObject({
        eventName: 'organization_write_settled',
        properties: { intent: 'member_remove', outcome: 'failed' },
      });
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
    });

    it('settles the row failed when the owner-authority check rejects a keyed removal', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: removeRow(),
      });
      mockDbState.removeTargetMember = [{ role: 'owner', isBot: false }];
      mockEnsureOrganizationAccess.mockResolvedValue('admin');

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only an organization owner can manage owners',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'authorization_failed',
        })
      );
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
    });

    it('replays a settled failed removal as non-retryable instead of taking over', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'duplicate_settled',
        row: removeRow({
          status: 'failed',
          outcome_code: 'authorization_failed',
        }),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This action did not complete. Please try again.',
      });
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });

    it('leaves the row retryable when the admitted access re-check hits an operational error', async () => {
      // An operational database error from the access re-check is NOT a
      // definitive authorization rejection: it must be rethrown untouched and
      // must not settle the admitted row as a terminal authorization failure.
      mockAdmitOperation.mockResolvedValue({
        admission: 'admitted',
        row: removeRow(),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];
      mockEnsureOrganizationAccess.mockRejectedValue(new Error('database connection failed'));

      await expect(caller.remove(input)).rejects.toThrow('database connection failed');

      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
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
        row: removeRow(),
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
        row: removeRow(),
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

    it('settles the row failed when the takeover access re-check rejects a member removal', async () => {
      // A takeover retry must not bypass the access re-check: a definitive
      // authorization rejection settles the row `failed` before the original
      // typed error returns, so a later same-key retry replays the rejection
      // instead of taking over again.
      mockAdmitOperation.mockResolvedValue({
        admission: 'takeover',
        row: removeRow(),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];
      mockEnsureOrganizationAccess.mockRejectedValue(
        new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have the required organizational role to access this feature',
        })
      );

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'authorization_failed',
        })
      );
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
    });

    it('settles the row failed when the takeover owner-authority check rejects a member removal', async () => {
      mockAdmitOperation.mockResolvedValue({
        admission: 'takeover',
        row: removeRow(),
      });
      mockDbState.removeTargetMember = [{ role: 'owner', isBot: false }];
      mockEnsureOrganizationAccess.mockResolvedValue('admin');

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only an organization owner can manage owners',
      });

      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'authorization_failed',
        })
      );
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
    });

    it('leaves the row retryable when the takeover access re-check hits an operational error', async () => {
      // An operational database error during the takeover re-check is rethrown
      // untouched and never settles the row: the retry stays retryable.
      mockAdmitOperation.mockResolvedValue({
        admission: 'takeover',
        row: removeRow(),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: false }];
      mockEnsureOrganizationAccess.mockRejectedValue(new Error('database connection failed'));

      await expect(caller.remove(input)).rejects.toThrow('database connection failed');

      expect(mockSettleOperation).not.toHaveBeenCalled();
      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
    });

    it('refuses to remove a service account during takeover repair (settles failed)', async () => {
      // The member is still present and is a bot: the read-back repair must
      // retain the service-account guard instead of re-running the removal
      // helper, and the refusal settles the row failed so a later same-key
      // retry replays the typed rejection instead of taking over past the
      // guard.
      mockAdmitOperation.mockResolvedValue({
        admission: 'takeover',
        row: removeRow(),
      });
      mockDbState.removeTargetMember = [{ role: 'member', isBot: true }];
      mockDbState.memberReadBack = [{ id: MEMBER_ID, isBot: true }];

      await expect(caller.remove(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Service account users cannot be removed',
      });

      expect(mockRemoveUserFromOrganization).not.toHaveBeenCalled();
      expect(mockSettleOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rowId: 'org-ledger-row-id',
          status: 'failed',
          outcomeCode: 'bot_removal_refused',
        })
      );
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRevokeGatewayStateForOrganizationMember).not.toHaveBeenCalled();
    });
  });
});

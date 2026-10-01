import { describe, expect, test } from '@jest/globals';

import {
  OrganizationServiceFeeExemptionError,
  getEffectiveOrganizationServiceFeeExemption,
  getOrganizationServiceFeeExemption,
  normalizeOrganizationExemptionTimestamp,
  normalizeOrganizationServiceFeeExemptionReason,
  organizationServiceFeeExemptionLockKey,
  setOrganizationServiceFeeExemption,
  type OrganizationServiceFeeExemptionRecord,
  type OrganizationServiceFeeExemptionStore,
} from '@/lib/service-fees/organization-exemptions';

function createMemoryExemptionStore(options?: {
  activeOrganizationIds?: Iterable<string>;
}): OrganizationServiceFeeExemptionStore & {
  calls: string[];
} {
  const active = new Set(options?.activeOrganizationIds ?? []);
  const history: OrganizationServiceFeeExemptionRecord[] = [];
  const calls: string[] = [];

  const store: OrganizationServiceFeeExemptionStore & { calls: string[] } = {
    calls,
    async transact(fn) {
      calls.push('transact');
      return fn(store);
    },
    async lockOrganization(organizationId) {
      calls.push(`lock:${organizationId}`);
    },
    async findActiveOrganization(organizationId) {
      calls.push(`findOrg:${organizationId}`);
      return active.has(organizationId) ? { id: organizationId } : null;
    },
    async findAtOrBefore(organizationId, at) {
      const atMs = at.getTime();
      return (
        history
          .filter(
            row =>
              row.organizationId === organizationId && new Date(row.createdAt).getTime() <= atMs
          )
          .at(-1) ?? null
      );
    },
    async listNewestFirst(organizationId) {
      return history
        .filter(row => row.organizationId === organizationId)
        .slice()
        .reverse();
    },
    async getCurrent(organizationId) {
      return history.filter(row => row.organizationId === organizationId).at(-1) ?? null;
    },
    async insert(record) {
      calls.push(`insert:${record.id}`);
      history.push(record);
      return record;
    },
  };

  return store;
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('organization service fee exemptions', () => {
  test('normalizes production timestamptz text and trims reasons', () => {
    expect(normalizeOrganizationExemptionTimestamp('2026-04-29 01:16:12.945+00')).toBe(
      '2026-04-29T01:16:12.945Z'
    );
    expect(normalizeOrganizationServiceFeeExemptionReason('  granted for nonprofit  ')).toBe(
      'granted for nonprofit'
    );
    expect(() => normalizeOrganizationServiceFeeExemptionReason('no')).toThrow(
      OrganizationServiceFeeExemptionError
    );
    expect(() => normalizeOrganizationServiceFeeExemptionReason('x'.repeat(501))).toThrow(
      /3 to 500/
    );
    expect(organizationServiceFeeExemptionLockKey(ORG_A)).toBe(`service-fee-exemption:${ORG_A}`);
  });

  test('reads the latest history row at or before the eligibility instant', async () => {
    const store = createMemoryExemptionStore({ activeOrganizationIds: [ORG_A] });
    await setOrganizationServiceFeeExemption({
      store,
      organizationId: ORG_A,
      isExempt: true,
      reason: 'historical grant',
      changedByKiloUserId: 'admin_1',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    await setOrganizationServiceFeeExemption({
      store,
      organizationId: ORG_A,
      isExempt: false,
      reason: 'revoked after review',
      changedByKiloUserId: 'admin_2',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });

    const atGrant = await getEffectiveOrganizationServiceFeeExemption({
      store,
      organizationId: ORG_A,
      at: new Date('2026-09-01T00:00:00.000Z'),
    });
    const atRevoke = await getEffectiveOrganizationServiceFeeExemption({
      store,
      organizationId: ORG_A,
      at: new Date('2026-10-01T00:00:00.000Z'),
    });
    const otherOrg = await getEffectiveOrganizationServiceFeeExemption({
      store,
      organizationId: ORG_B,
      at: new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(atGrant).toMatchObject({ isExempt: true, reason: 'historical grant' });
    expect(atRevoke).toMatchObject({ isExempt: false, reason: 'revoked after review' });
    expect(otherOrg).toBeNull();
  });

  test('set appends each change and allows the same state with a new reason', async () => {
    const store = createMemoryExemptionStore({ activeOrganizationIds: [ORG_A] });

    const first = await setOrganizationServiceFeeExemption({
      store,
      organizationId: ORG_A,
      isExempt: true,
      reason: '  initial grant  ',
      changedByKiloUserId: 'admin_1',
      now: new Date('2026-09-02T00:00:00.000Z'),
    });
    const second = await setOrganizationServiceFeeExemption({
      store,
      organizationId: ORG_A,
      isExempt: true,
      reason: 'renewed with new documentation',
      changedByKiloUserId: 'admin_2',
      now: new Date('2026-09-02T00:00:00.000Z'),
    });

    const view = await getOrganizationServiceFeeExemption({ store, organizationId: ORG_A });

    expect(first.current.isExempt).toBe(true);
    expect(first.current.reason).toBe('initial grant');
    expect(second.current.id).toBe(second.history.id);
    expect(second.current.createdAt).toBe('2026-09-02T00:00:00.001Z');
    expect(view.history.map(row => row.reason)).toEqual([
      'renewed with new documentation',
      'initial grant',
    ]);
    expect(view.current?.reason).toBe('renewed with new documentation');
    expect(store.calls.filter(call => call.startsWith('lock:'))).toHaveLength(2);
    expect(store.calls.filter(call => call.startsWith('insert:'))).toHaveLength(2);
  });

  test('rejects missing or deleted organizations', async () => {
    const store = createMemoryExemptionStore({ activeOrganizationIds: [] });

    await expect(
      setOrganizationServiceFeeExemption({
        store,
        organizationId: ORG_A,
        isExempt: true,
        reason: 'should not persist',
        changedByKiloUserId: 'admin_1',
      })
    ).rejects.toMatchObject({ code: 'organization_not_found' });

    const view = await getOrganizationServiceFeeExemption({ store, organizationId: ORG_A });
    expect(view.current).toBeNull();
    expect(view.history).toEqual([]);
  });
});

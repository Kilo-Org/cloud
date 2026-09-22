import { describe, expect, it } from '@jest/globals';
import {
  AdminSlackNotificationError,
  type AdminSlackNotification,
} from '@/lib/slack/admin-notifications';
import {
  assertServiceFeeAuditReadOnly,
  auditRestrictedCoupons,
  buildRestrictedCouponSlackNotification,
  couponSnapshotFromListCoupon,
  couponSnapshotFromResolvedCoupon,
  evaluateRestrictedCouponAudit,
  findRestrictedFeeBearingCoupons,
  listAllStripePages,
  listCouponSnapshotsEnsuringAppliesTo,
  parseRestrictedCouponAuditArgs,
  SERVICE_FEE_RESTRICTED_COUPON_EVENT,
  SERVICE_FEE_RESTRICTED_COUPON_NAMESPACE,
  type StripeCouponSnapshot,
  type StripeCouponSnapshotSource,
} from './restricted-coupon-audit';

const FEE_PRODUCTS = new Set(['prod_kilo_pass', 'prod_top_up']);

function coupon(overrides: Partial<StripeCouponSnapshot> = {}): StripeCouponSnapshot {
  return {
    id: 'co_restricted',
    valid: true,
    appliesToProductIds: ['prod_kilo_pass'],
    ...overrides,
  };
}

describe('findRestrictedFeeBearingCoupons', () => {
  it('ignores unrestricted coupons and coupons restricted to non-fee products', () => {
    expect(
      findRestrictedFeeBearingCoupons({
        coupons: [
          coupon({ id: 'co_open', appliesToProductIds: null }),
          coupon({ id: 'co_empty', appliesToProductIds: [] }),
          coupon({ id: 'co_seats', appliesToProductIds: ['prod_seats'] }),
          coupon({ id: 'co_claw', appliesToProductIds: ['prod_kiloclaw'] }),
        ],
        feeBearingProductIds: FEE_PRODUCTS,
      })
    ).toEqual([]);
  });

  it('lists coupons whose applies_to products intersect Kilo Pass or top-up products', () => {
    expect(
      findRestrictedFeeBearingCoupons({
        coupons: [
          coupon({ id: 'co_pass', appliesToProductIds: ['prod_kilo_pass', 'prod_seats'] }),
          coupon({
            id: 'co_topup',
            valid: false,
            appliesToProductIds: ['prod_top_up'],
          }),
          coupon({ id: 'co_other', appliesToProductIds: ['prod_seats'] }),
        ],
        feeBearingProductIds: FEE_PRODUCTS,
      })
    ).toEqual([
      {
        couponId: 'co_pass',
        valid: true,
        intersectingProductIds: ['prod_kilo_pass'],
        appliesToProductCount: 2,
      },
      {
        couponId: 'co_topup',
        valid: false,
        intersectingProductIds: ['prod_top_up'],
        appliesToProductCount: 1,
      },
    ]);
  });
});

describe('evaluateRestrictedCouponAudit', () => {
  it('builds a namespaced non-sensitive alert only when restricted coupons exist', () => {
    const clear = evaluateRestrictedCouponAudit({
      generatedAtIso: '2026-08-09T00:00:00.000Z',
      coupons: [coupon({ id: 'co_open', appliesToProductIds: null })],
      feeBearingProductIds: FEE_PRODUCTS,
    });
    expect(clear.alert).toBeNull();
    expect(clear.findings).toEqual([]);

    const report = evaluateRestrictedCouponAudit({
      generatedAtIso: '2026-08-09T00:00:00.000Z',
      coupons: [
        coupon({ id: 'co_pass' }),
        coupon({ id: 'co_topup', appliesToProductIds: ['prod_top_up'] }),
      ],
      feeBearingProductIds: FEE_PRODUCTS,
    });

    expect(report.alert).toEqual({
      namespace: SERVICE_FEE_RESTRICTED_COUPON_NAMESPACE,
      event: SERVICE_FEE_RESTRICTED_COUPON_EVENT,
      generatedAtIso: '2026-08-09T00:00:00.000Z',
      couponCount: 2,
      couponIds: ['co_pass', 'co_topup'],
      intersectingProductIds: ['prod_kilo_pass', 'prod_top_up'],
    });
  });

  it('keeps Slack copy limited to namespaced identifiers and validity', () => {
    const report = evaluateRestrictedCouponAudit({
      generatedAtIso: '2026-08-09T00:00:00.000Z',
      coupons: [coupon({ id: 'co_pass', appliesToProductIds: ['prod_kilo_pass'] })],
      feeBearingProductIds: FEE_PRODUCTS,
    });
    if (!report.alert) throw new Error('expected alert');

    const notification = buildRestrictedCouponSlackNotification(report.alert, report.findings);
    const serialized = JSON.stringify(notification);

    expect(notification.text).toContain(SERVICE_FEE_RESTRICTED_COUPON_EVENT);
    expect(serialized).toContain('co_pass');
    expect(serialized).toContain('prod_kilo_pass');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('sk_');
    expect(serialized).not.toContain('@');
  });
});

describe('restricted coupon audit args and orchestration', () => {
  it('defaults to read-only alerting and rejects mutating flags', () => {
    expect(parseRestrictedCouponAuditArgs([])).toEqual({ alert: true });
    expect(parseRestrictedCouponAuditArgs(['--no-alert'])).toEqual({ alert: false });
    expect(() => assertServiceFeeAuditReadOnly(['--execute'])).toThrow(
      'service_fee_audit_is_read_only'
    );
    expect(() => parseRestrictedCouponAuditArgs(['--run-actually'])).toThrow(
      'service_fee_audit_is_read_only'
    );
  });

  it('alerts through injected functions with a namespaced payload and no secrets', async () => {
    const notifications: AdminSlackNotification[] = [];
    const captured: unknown[] = [];
    const events: Array<Record<string, unknown>> = [];

    const report = await auditRestrictedCoupons({
      generatedAtIso: '2026-08-09T00:00:00.000Z',
      listCoupons: async () => [coupon({ id: 'co_pass' })],
      listFeeBearingProductIds: async () => ['prod_kilo_pass', 'prod_top_up'],
      sendAlert: async notification => {
        notifications.push(notification);
      },
      capture: payload => {
        captured.push(payload);
      },
      log: event => {
        events.push(event);
      },
    });

    expect(report.findings).toHaveLength(1);
    expect(captured).toEqual([
      expect.objectContaining({
        namespace: SERVICE_FEE_RESTRICTED_COUPON_NAMESPACE,
        event: SERVICE_FEE_RESTRICTED_COUPON_EVENT,
        couponIds: ['co_pass'],
      }),
    ]);
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications[0])).not.toContain('sk_');
    expect(
      events.some(event => event.event === `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.alerted`)
    ).toBe(true);
  });

  it('records only Slack kind/status when the injected alert fails', async () => {
    const events: Array<Record<string, unknown>> = [];

    await expect(
      auditRestrictedCoupons({
        generatedAtIso: '2026-08-09T00:00:00.000Z',
        listCoupons: async () => [coupon({ id: 'co_pass' })],
        listFeeBearingProductIds: async () => ['prod_kilo_pass'],
        sendAlert: async () => {
          throw new AdminSlackNotificationError('upstream', 500);
        },
        log: event => {
          events.push(event);
        },
      })
    ).rejects.toMatchObject({ kind: 'upstream', status: 500 });

    expect(events).toContainEqual(
      expect.objectContaining({
        event: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.alert_failed`,
        kind: 'upstream',
        status: 500,
        couponCount: 1,
      })
    );
    expect(JSON.stringify(events)).not.toContain('hooks.slack.com');
  });
});

describe('coupon snapshots from Stripe payloads', () => {
  it('treats a list payload that omits applies_to as unresolved, never as unrestricted', () => {
    const omitted: StripeCouponSnapshotSource = { id: 'co_omitted', valid: true };
    expect(couponSnapshotFromListCoupon(omitted)).toBeNull();
  });

  it('reads the expanded applies_to restriction from the list payload without a retrieve', () => {
    expect(
      couponSnapshotFromListCoupon({
        id: 'co_restricted',
        valid: true,
        applies_to: { products: ['prod_kilo_pass'] },
      })
    ).toEqual({
      id: 'co_restricted',
      valid: true,
      appliesToProductIds: ['prod_kilo_pass'],
    });
  });

  it('maps an explicitly empty applies_to to an unrestricted snapshot', () => {
    expect(
      couponSnapshotFromResolvedCoupon({ id: 'co_open', valid: false, applies_to: null })
    ).toEqual({ id: 'co_open', valid: false, appliesToProductIds: null });
    expect(
      couponSnapshotFromResolvedCoupon({
        id: 'co_empty',
        valid: true,
        applies_to: { products: [] },
      })
    ).toEqual({ id: 'co_empty', valid: true, appliesToProductIds: [] });
  });
});

describe('listCouponSnapshotsEnsuringAppliesTo', () => {
  it('uses the expanded list restriction and never retrieves when applies_to is present', async () => {
    const retrieved: string[] = [];
    const snapshots = await listCouponSnapshotsEnsuringAppliesTo({
      listPage: async () => ({
        data: [
          { id: 'co_a', valid: true, applies_to: { products: ['prod_kilo_pass'] } },
          { id: 'co_b', valid: false, applies_to: { products: [] } },
        ],
        has_more: false,
      }),
      retrieveCoupon: async couponId => {
        retrieved.push(couponId);
        throw new Error(`unexpected retrieve for ${couponId}`);
      },
      log: () => {},
    });

    expect(retrieved).toEqual([]);
    expect(snapshots).toEqual([
      { id: 'co_a', valid: true, appliesToProductIds: ['prod_kilo_pass'] },
      { id: 'co_b', valid: false, appliesToProductIds: [] },
    ]);
  });

  it('retrieves coupons whose list payload omitted applies_to so restrictions are never missed', async () => {
    const events: Array<Record<string, unknown>> = [];
    const snapshots = await listCouponSnapshotsEnsuringAppliesTo({
      listPage: async () => ({
        data: [
          { id: 'co_omitted', valid: true },
          { id: 'co_present', valid: true, applies_to: { products: [] } },
        ],
        has_more: false,
      }),
      retrieveCoupon: async couponId => {
        expect(couponId).toBe('co_omitted');
        return { id: couponId, valid: true, applies_to: { products: ['prod_top_up'] } };
      },
      log: event => {
        events.push(event);
      },
    });

    expect(snapshots).toEqual([
      { id: 'co_omitted', valid: true, appliesToProductIds: ['prod_top_up'] },
      { id: 'co_present', valid: true, appliesToProductIds: [] },
    ]);
    expect(events).toEqual([
      {
        event: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.applies_to_retrieved`,
        mode: 'read_only',
        retrievedCount: 1,
        couponCount: 2,
      },
    ]);
  });

  it('paginates with starting_after and retrieves omitted coupons across pages', async () => {
    const listCalls: Array<string | undefined> = [];
    const retrieved: string[] = [];

    const snapshots = await listCouponSnapshotsEnsuringAppliesTo({
      listPage: async startingAfter => {
        listCalls.push(startingAfter);
        if (!startingAfter) {
          return {
            data: [
              { id: 'co_1', valid: true, applies_to: { products: ['prod_kilo_pass'] } },
              { id: 'co_2', valid: true },
            ],
            has_more: true,
          };
        }
        return { data: [{ id: 'co_3', valid: false }], has_more: false };
      },
      retrieveCoupon: async couponId => {
        retrieved.push(couponId);
        return { id: couponId, valid: couponId !== 'co_3', applies_to: null };
      },
      log: () => {},
    });

    expect(listCalls).toEqual([undefined, 'co_2']);
    expect(retrieved).toEqual(['co_2', 'co_3']);
    expect(snapshots.map(snapshot => snapshot.id)).toEqual(['co_1', 'co_2', 'co_3']);
    expect(snapshots[0].appliesToProductIds).toEqual(['prod_kilo_pass']);
    expect(snapshots[1].appliesToProductIds).toBeNull();
    expect(snapshots[2]).toEqual({ id: 'co_3', valid: false, appliesToProductIds: null });
  });
});

describe('listAllStripePages', () => {
  it('walks injected pages until has_more is false', async () => {
    const calls: Array<string | undefined> = [];
    const rows = await listAllStripePages(async startingAfter => {
      calls.push(startingAfter);
      if (!startingAfter) {
        return { data: [{ id: 'co_1' }, { id: 'co_2' }], has_more: true };
      }
      return { data: [{ id: 'co_3' }], has_more: false };
    });

    expect(calls).toEqual([undefined, 'co_2']);
    expect(rows.map(row => row.id)).toEqual(['co_1', 'co_2', 'co_3']);
  });

  it('fails when a page claims more results without a cursor', async () => {
    await expect(listAllStripePages(async () => ({ data: [], has_more: true }))).rejects.toThrow(
      'stripe page is marked has_more without a cursor'
    );
  });
});

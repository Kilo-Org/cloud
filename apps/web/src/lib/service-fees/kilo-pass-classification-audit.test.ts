import { describe, expect, it } from '@jest/globals';
import {
  auditKiloPassClassifications,
  classifyOrganizationKiloPassSubscription,
  classifyPersonalKiloPassSubscription,
  evaluateKiloPassClassificationAudit,
  type OrganizationKiloPassAuditRow,
  type PersonalKiloPassAuditRow,
  type StripeSubscriptionSnapshot,
} from './kilo-pass-classification-audit';

const KILO_PASS_PRICE = 'price_kilo_pass_49';
const SEAT_PRODUCT = 'prod_seats';
const knownKiloPassPriceIds = new Set([KILO_PASS_PRICE]);
const seatProductIds = new Set([SEAT_PRODUCT]);

function personalRow(overrides: Partial<PersonalKiloPassAuditRow> = {}): PersonalKiloPassAuditRow {
  return {
    id: 'kps_1',
    kiloUserId: 'user_1',
    stripeSubscriptionId: 'sub_personal',
    status: 'active',
    tier: 'tier_49',
    cadence: 'monthly',
    ...overrides,
  };
}

function organizationRow(
  overrides: Partial<OrganizationKiloPassAuditRow> = {}
): OrganizationKiloPassAuditRow {
  return {
    id: 'kpoa_1',
    organizationId: 'org_1',
    providerSubscriptionId: 'sub_org',
    providerSeatAddOnItemId: 'si_pass',
    state: 'active',
    purchaseChannel: 'self_serve',
    ...overrides,
  };
}

function personalSubscription(
  overrides: Partial<StripeSubscriptionSnapshot> = {}
): StripeSubscriptionSnapshot {
  return {
    id: 'sub_personal',
    status: 'active',
    metadata: {
      type: 'kilo-pass',
      kiloUserId: 'user_1',
      tier: 'tier_49',
      cadence: 'monthly',
    },
    items: [{ id: 'si_pass', priceId: KILO_PASS_PRICE, productId: 'prod_kilo_pass' }],
    ...overrides,
  };
}

function organizationSubscription(
  overrides: Partial<StripeSubscriptionSnapshot> = {}
): StripeSubscriptionSnapshot {
  return {
    id: 'sub_org',
    status: 'active',
    metadata: {
      type: 'kilo-pass-org',
      organizationId: 'org_1',
      kiloUserId: 'user_1',
      tier: 'tier_49',
      cadence: 'monthly',
    },
    items: [
      { id: 'si_seat', priceId: 'price_seats', productId: SEAT_PRODUCT },
      { id: 'si_pass', priceId: KILO_PASS_PRICE, productId: 'prod_kilo_pass' },
    ],
    ...overrides,
  };
}

describe('personal Kilo Pass classification', () => {
  it('classifies an active Stripe-managed subscription by known price and personal metadata', () => {
    const result = classifyPersonalKiloPassSubscription({
      row: personalRow(),
      subscription: personalSubscription(),
      knownKiloPassPriceIds,
    });

    expect(result.classifiable).toBe(true);
    expect(result.resolvedItemId).toBe('si_pass');
    expect(result.issues).toEqual([]);
  });

  it('treats a known price without personal metadata as classifiable with a warning', () => {
    const result = classifyPersonalKiloPassSubscription({
      row: personalRow(),
      subscription: personalSubscription({ metadata: {} }),
      knownKiloPassPriceIds,
    });

    expect(result.classifiable).toBe(true);
    expect(result.issues).toEqual([
      { code: 'missing_personal_kilo_pass_metadata', severity: 'warning' },
    ]);
  });

  it('rejects a personal subscription that also carries organization metadata', () => {
    const result = classifyPersonalKiloPassSubscription({
      row: personalRow(),
      subscription: personalSubscription({
        metadata: {
          type: 'kilo-pass-org',
          organizationId: 'org_1',
          kiloUserId: 'user_1',
          tier: 'tier_49',
          cadence: 'monthly',
        },
      }),
      knownKiloPassPriceIds,
    });

    expect(result.classifiable).toBe(false);
    expect(result.issues.map(issue => issue.code)).toEqual([
      'has_organization_kilo_pass_metadata',
      'missing_personal_kilo_pass_metadata',
    ]);
  });

  it('rejects a missing Stripe subscription and a subscription without a known Kilo Pass price', () => {
    expect(
      classifyPersonalKiloPassSubscription({
        row: personalRow({ stripeSubscriptionId: null }),
        subscription: undefined,
        knownKiloPassPriceIds,
      }).issues.map(issue => issue.code)
    ).toEqual(['missing_stripe_subscription_id']);

    expect(
      classifyPersonalKiloPassSubscription({
        row: personalRow(),
        subscription: null,
        knownKiloPassPriceIds,
      }).issues.map(issue => issue.code)
    ).toEqual(['stripe_subscription_not_found']);

    expect(
      classifyPersonalKiloPassSubscription({
        row: personalRow(),
        subscription: personalSubscription({
          items: [{ id: 'si_other', priceId: 'price_other', productId: 'prod_other' }],
        }),
        knownKiloPassPriceIds,
      }).issues.map(issue => issue.code)
    ).toEqual(['missing_known_kilo_pass_price']);
  });
});

describe('organization Kilo Pass classification', () => {
  it('resolves the bound non-seat add-on item before falling back to price search', () => {
    const result = classifyOrganizationKiloPassSubscription({
      row: organizationRow(),
      subscription: organizationSubscription(),
      knownKiloPassPriceIds,
      seatProductIds,
    });

    expect(result.classifiable).toBe(true);
    expect(result.resolvedItemId).toBe('si_pass');
    expect(result.issues).toEqual([]);
  });

  it('falls back to a unique known non-seat price when the add-on id is unbound', () => {
    const result = classifyOrganizationKiloPassSubscription({
      row: organizationRow({ providerSeatAddOnItemId: null }),
      subscription: organizationSubscription(),
      knownKiloPassPriceIds,
      seatProductIds,
    });

    expect(result.classifiable).toBe(true);
    expect(result.resolvedItemId).toBe('si_pass');
    expect(result.issues).toEqual([{ code: 'unresolved_kilo_pass_item', severity: 'warning' }]);
  });

  it('rejects org metadata that is missing, personal, or bound to a seat item', () => {
    expect(
      classifyOrganizationKiloPassSubscription({
        row: organizationRow(),
        subscription: organizationSubscription({ metadata: {} }),
        knownKiloPassPriceIds,
        seatProductIds,
      }).issues.map(issue => issue.code)
    ).toEqual(['missing_organization_kilo_pass_metadata']);

    expect(
      classifyOrganizationKiloPassSubscription({
        row: organizationRow(),
        subscription: organizationSubscription({
          metadata: {
            type: 'kilo-pass',
            kiloUserId: 'user_1',
            tier: 'tier_49',
            cadence: 'monthly',
          },
        }),
        knownKiloPassPriceIds,
        seatProductIds,
      }).issues.map(issue => issue.code)
    ).toEqual(['has_personal_kilo_pass_metadata', 'missing_organization_kilo_pass_metadata']);

    expect(
      classifyOrganizationKiloPassSubscription({
        row: organizationRow({ providerSeatAddOnItemId: 'si_seat' }),
        subscription: organizationSubscription(),
        knownKiloPassPriceIds,
        seatProductIds,
      }).issues.map(issue => issue.code)
    ).toEqual(['bound_add_on_item_is_seat']);
  });

  it('rejects a bound item that is missing or not a known Kilo Pass price', () => {
    expect(
      classifyOrganizationKiloPassSubscription({
        row: organizationRow({ providerSeatAddOnItemId: 'si_missing' }),
        subscription: organizationSubscription(),
        knownKiloPassPriceIds,
        seatProductIds,
      }).issues.map(issue => issue.code)
    ).toEqual(['bound_add_on_item_not_found']);

    expect(
      classifyOrganizationKiloPassSubscription({
        row: organizationRow({ providerSeatAddOnItemId: 'si_other' }),
        subscription: organizationSubscription({
          items: [{ id: 'si_other', priceId: 'price_other', productId: 'prod_other' }],
        }),
        knownKiloPassPriceIds,
        seatProductIds,
      }).issues.map(issue => issue.code)
    ).toEqual(['bound_add_on_item_unknown_price']);
  });

  it('rejects multiple unbound known Kilo Pass items as ambiguous', () => {
    const result = classifyOrganizationKiloPassSubscription({
      row: organizationRow({ providerSeatAddOnItemId: null }),
      subscription: organizationSubscription({
        items: [
          { id: 'si_pass_a', priceId: KILO_PASS_PRICE, productId: 'prod_kilo_pass' },
          { id: 'si_pass_b', priceId: KILO_PASS_PRICE, productId: 'prod_kilo_pass' },
        ],
      }),
      knownKiloPassPriceIds,
      seatProductIds,
    });

    expect(result.classifiable).toBe(false);
    expect(result.issues.map(issue => issue.code)).toEqual(['ambiguous_kilo_pass_items']);
  });
});

describe('evaluateKiloPassClassificationAudit', () => {
  it('loads subscriptions only through the injected retrieve function', async () => {
    const retrieved: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const report = await auditKiloPassClassifications({
      generatedAtIso: '2026-08-09T00:00:00.000Z',
      knownKiloPassPriceIds,
      seatProductIds,
      store: {
        listPersonalRows: async () => [personalRow()],
        listOrganizationRows: async () => [organizationRow()],
      },
      retrieveSubscription: async subscriptionId => {
        retrieved.push(subscriptionId);
        return subscriptionId === 'sub_personal'
          ? personalSubscription()
          : organizationSubscription();
      },
      log: event => {
        events.push(event);
      },
    });

    expect(retrieved.sort()).toEqual(['sub_org', 'sub_personal']);
    expect(report.classifiableCount).toBe(2);
    expect(events[0]).toMatchObject({
      event: 'service_fee.kilo_pass_classification_audit.started',
      mode: 'read_only',
    });
    expect(events.at(-1)).toMatchObject({
      event: 'service_fee.kilo_pass_classification_audit.completed',
      unclassifiableCount: 0,
    });
  });

  it('summarizes injected personal and organization rows without mutating them', () => {
    const personal = personalRow();
    const organization = organizationRow();
    const report = evaluateKiloPassClassificationAudit({
      generatedAtIso: '2026-08-09T00:00:00.000Z',
      knownKiloPassPriceIds,
      seatProductIds,
      personalRows: [personal],
      organizationRows: [organization],
      subscriptionsById: new Map([
        [personal.stripeSubscriptionId ?? '', personalSubscription()],
        [organization.providerSubscriptionId ?? '', organizationSubscription()],
      ]),
    });

    expect(report).toMatchObject({
      generatedAtIso: '2026-08-09T00:00:00.000Z',
      personalReviewed: 1,
      organizationReviewed: 1,
      classifiableCount: 2,
      unclassifiableCount: 0,
      warningCount: 0,
    });
    expect(report.results.map(result => result.kind)).toEqual([
      'personal_kilo_pass',
      'organization_kilo_pass',
    ]);
  });
});

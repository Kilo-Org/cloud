import type Stripe from 'stripe';

import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { credit_transactions, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { fetchTopUpTransactionForStripeSession } from './actions';

jest.mock('@kilocode/web-shared/lib/stripe-client', () => {
  const stripeMock = {
    checkout: {
      sessions: {
        retrieve: jest.fn(),
      },
    },
  };
  return { client: stripeMock, __stripeMock: stripeMock };
});

jest.mock('@kilocode/web-shared/lib/user/server');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const stripeMock = (
  jest.requireMock('@kilocode/web-shared/lib/stripe-client') as {
    __stripeMock: { checkout: { sessions: { retrieve: jest.Mock } } };
  }
).__stripeMock;

function makeSession(params: {
  id?: string;
  metadata?: Record<string, string>;
  paymentStatus?: string;
  paymentIntentId?: string | null;
  latestChargeId?: string | null;
}): Stripe.Checkout.Session {
  const paymentIntentId = params.paymentIntentId ?? 'pi_test_1';
  return {
    id: params.id ?? 'cs_test_1',
    object: 'checkout.session',
    metadata: params.metadata ?? {},
    payment_status: params.paymentStatus ?? 'paid',
    payment_intent:
      paymentIntentId === null
        ? null
        : {
            id: paymentIntentId,
            object: 'payment_intent',
            latest_charge: params.latestChargeId ?? null,
          },
  } as unknown as Stripe.Checkout.Session;
}

async function insertLedgerRow(params: {
  kiloUserId: string;
  organizationId: string | null;
  stripePaymentId: string;
  createdByKiloUserId?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(credit_transactions)
    .values({
      kilo_user_id: params.kiloUserId,
      organization_id: params.organizationId,
      amount_microdollars: 20_000_000,
      is_free: false,
      description: 'Top-up via stripe',
      stripe_payment_id: params.stripePaymentId,
      original_baseline_microdollars_used: 0,
      created_by_kilo_user_id: params.createdByKiloUserId ?? null,
    })
    .returning({ id: credit_transactions.id });
  return row.id;
}

beforeEach(() => {
  stripeMock.checkout.sessions.retrieve.mockReset();
  mockedGetUserFromAuth.mockReset();
});

afterEach(async () => {
  await cleanupDbForTest();
});

describe('fetchTopUpTransactionForStripeSession', () => {
  it('returns the redirect fields for the account that created the checkout', async () => {
    const buyer = await insertTestUser();
    const transactionId = await insertLedgerRow({
      kiloUserId: buyer.id,
      organizationId: null,
      stripePaymentId: 'ch_test_owner',
    });
    mockedGetUserFromAuth.mockResolvedValue({ user: buyer, authFailedResponse: null });
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(
      makeSession({
        metadata: { type: 'stripe-checkout-topup', kiloUserId: buyer.id },
        latestChargeId: 'ch_test_owner',
      })
    );

    await expect(fetchTopUpTransactionForStripeSession('cs_test_1')).resolves.toEqual({
      status: 'found',
      transaction: { id: transactionId, organizationId: null, amountMicrodollars: 20_000_000 },
    });
  });

  it('matches a ledger row recorded with the payment intent id', async () => {
    const buyer = await insertTestUser();
    const transactionId = await insertLedgerRow({
      kiloUserId: buyer.id,
      organizationId: null,
      stripePaymentId: 'pi_test_intent',
    });
    mockedGetUserFromAuth.mockResolvedValue({ user: buyer, authFailedResponse: null });
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(
      makeSession({
        metadata: { kiloUserId: buyer.id },
        paymentIntentId: 'pi_test_intent',
      })
    );

    const result = await fetchTopUpTransactionForStripeSession('cs_test_1');

    expect(result).toEqual({
      status: 'found',
      transaction: { id: transactionId, organizationId: null, amountMicrodollars: 20_000_000 },
    });
  });

  it('reports pending while the ledger row is still settling', async () => {
    const buyer = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: buyer, authFailedResponse: null });
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(
      makeSession({ metadata: { kiloUserId: buyer.id } })
    );

    await expect(fetchTopUpTransactionForStripeSession('cs_test_1')).resolves.toEqual({
      status: 'pending',
    });
  });

  it('returns nothing for a session created by another account', async () => {
    const buyer = await insertTestUser();
    const otherCaller = await insertTestUser();
    await insertLedgerRow({
      kiloUserId: buyer.id,
      organizationId: null,
      stripePaymentId: 'ch_test_other_owner',
    });
    mockedGetUserFromAuth.mockResolvedValue({ user: otherCaller, authFailedResponse: null });
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(
      makeSession({
        metadata: { kiloUserId: buyer.id },
        latestChargeId: 'ch_test_other_owner',
      })
    );

    await expect(fetchTopUpTransactionForStripeSession('cs_test_1')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('returns nothing for a checkout without an account reference', async () => {
    const caller = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: caller, authFailedResponse: null });
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(makeSession({ metadata: {} }));

    await expect(fetchTopUpTransactionForStripeSession('cs_test_1')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('returns nothing for a signed-out caller without retrieving anything', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: { status: 401 } as never,
    });

    await expect(fetchTopUpTransactionForStripeSession('cs_test_1')).resolves.toEqual({
      status: 'unavailable',
    });
    expect(stripeMock.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('returns nothing for a malformed or unknown session id', async () => {
    const caller = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: caller, authFailedResponse: null });

    await expect(fetchTopUpTransactionForStripeSession('not-a-session')).resolves.toEqual({
      status: 'unavailable',
    });
    expect(stripeMock.checkout.sessions.retrieve).not.toHaveBeenCalled();

    stripeMock.checkout.sessions.retrieve.mockRejectedValue(new Error('No such checkout.session'));
    await expect(fetchTopUpTransactionForStripeSession('cs_test_unknown')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('resolves an organization purchase for a billing administrator of that organization', async () => {
    const owner = await insertTestUser();
    const billingManager = await insertTestUser();
    const organization = await createTestOrganization('Top-up org', owner.id, 0);
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: billingManager.id,
      role: 'billing_manager',
    });
    const transactionId = await insertLedgerRow({
      kiloUserId: owner.id,
      organizationId: organization.id,
      stripePaymentId: 'pi_test_org',
    });
    mockedGetUserFromAuth.mockResolvedValue({ user: billingManager, authFailedResponse: null });
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(
      makeSession({
        metadata: { kiloUserId: owner.id, organizationId: organization.id },
        paymentIntentId: 'pi_test_org',
      })
    );

    await expect(fetchTopUpTransactionForStripeSession('cs_test_1')).resolves.toEqual({
      status: 'found',
      transaction: {
        id: transactionId,
        organizationId: organization.id,
        amountMicrodollars: 20_000_000,
      },
    });
  });

  it('resolves an organization purchase for a billing administrator of the parent organization', async () => {
    const owner = await insertTestUser();
    const parentOwner = await insertTestUser();
    const parent = await createTestOrganization('Parent org', parentOwner.id, 0);
    const child = await createOrganization('Child org');
    await db.insert(organization_memberships).values({
      organization_id: child.id,
      kilo_user_id: owner.id,
      role: 'owner',
    });
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));

    const transactionId = await insertLedgerRow({
      kiloUserId: owner.id,
      organizationId: child.id,
      stripePaymentId: 'pi_test_child_org',
    });
    mockedGetUserFromAuth.mockResolvedValue({ user: parentOwner, authFailedResponse: null });
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(
      makeSession({
        metadata: { kiloUserId: owner.id, organizationId: child.id },
        paymentIntentId: 'pi_test_child_org',
      })
    );

    await expect(fetchTopUpTransactionForStripeSession('cs_test_1')).resolves.toEqual({
      status: 'found',
      transaction: {
        id: transactionId,
        organizationId: child.id,
        amountMicrodollars: 20_000_000,
      },
    });
  });

  it('returns nothing for an organization purchase to a non-member', async () => {
    const owner = await insertTestUser();
    const outsider = await insertTestUser();
    const organization = await createTestOrganization('Top-up org', owner.id, 0);
    await insertLedgerRow({
      kiloUserId: owner.id,
      organizationId: organization.id,
      stripePaymentId: 'pi_test_org_outsider',
    });
    mockedGetUserFromAuth.mockResolvedValue({ user: outsider, authFailedResponse: null });
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(
      makeSession({
        metadata: { kiloUserId: owner.id, organizationId: organization.id },
        paymentIntentId: 'pi_test_org_outsider',
      })
    );

    await expect(fetchTopUpTransactionForStripeSession('cs_test_1')).resolves.toEqual({
      status: 'unavailable',
    });
  });
});

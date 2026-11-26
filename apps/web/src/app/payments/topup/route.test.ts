import { NextRequest } from 'next/server';
import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { decideCheckoutCharge } from '@kilocode/web-shared/lib/bouncer/charge-gate';
import { getStripeTopUpCheckoutUrl } from '@/lib/stripe';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/stripe', () => ({ getStripeTopUpCheckoutUrl: jest.fn() }));
jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/bouncer/charge-gate', () => ({
  CHARGE_GATE_BLOCKED_MESSAGE: 'blocked',
  decideCheckoutCharge: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCheckoutUrl = jest.mocked(getStripeTopUpCheckoutUrl);
const mockedCustomerId = jest.mocked(getOrCreateStripeCustomerIdForOrganization);
const mockedChargeGate = jest.mocked(decideCheckoutCharge);

const CHECKOUT_URL = 'https://checkout.example.test/session';

function postTopUp(organizationId: string): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/payments/topup?amount=20&organization-id=${organizationId}`, {
      method: 'POST',
    })
  );
}

async function organizationOf(): Promise<string> {
  const owner = await insertTestUser();
  return (await createTestOrganization('Top-up org', owner.id, 0)).id;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockedChargeGate.mockResolvedValue(null);
  mockedCustomerId.mockResolvedValue('cus_test_org');
  mockedCheckoutUrl.mockResolvedValue(CHECKOUT_URL);
});

afterEach(async () => {
  await cleanupDbForTest();
});

describe('POST /payments/topup for an organization', () => {
  it('starts a checkout for a billing manager of the organization', async () => {
    const organizationId = await organizationOf();
    const billingManager = await insertTestUser();
    await addUserToOrganization(organizationId, billingManager.id, 'billing_manager');
    mockedGetUserFromAuth.mockResolvedValue({ user: billingManager, authFailedResponse: null });

    const response = await postTopUp(organizationId);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(CHECKOUT_URL);
  });

  it('refuses a plain member and creates no checkout', async () => {
    const organizationId = await organizationOf();
    const member = await insertTestUser();
    await addUserToOrganization(organizationId, member.id, 'member');
    mockedGetUserFromAuth.mockResolvedValue({ user: member, authFailedResponse: null });

    const response = await postTopUp(organizationId);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Organization not found' });
    expect(mockedCheckoutUrl).not.toHaveBeenCalled();
  });

  it('refuses staff without a membership and creates no Stripe customer or checkout', async () => {
    const organizationId = await organizationOf();
    const staff = await insertTestUser({ is_admin: true });
    mockedGetUserFromAuth.mockResolvedValue({ user: staff, authFailedResponse: null });

    const response = await postTopUp(organizationId);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Organization not found' });
    expect(mockedCustomerId).not.toHaveBeenCalled();
    expect(mockedCheckoutUrl).not.toHaveBeenCalled();
  });

  it('starts a checkout for staff who hold a real billing role', async () => {
    const organizationId = await organizationOf();
    const staff = await insertTestUser({ is_admin: true });
    await addUserToOrganization(organizationId, staff.id, 'billing_manager');
    mockedGetUserFromAuth.mockResolvedValue({ user: staff, authFailedResponse: null });

    const response = await postTopUp(organizationId);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(CHECKOUT_URL);
  });
});

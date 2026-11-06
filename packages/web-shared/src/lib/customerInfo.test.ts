import { summarizeUserPayments } from '@kilocode/web-shared/lib/creditTransactions';
import { userHasOrganizations } from '@kilocode/web-shared/lib/organizations/organizations';
import { hasPaymentMethodInStripe } from '@kilocode/web-shared/lib/stripe-client';
import { hasReceivedAnyFreeWelcomeCredits } from '@kilocode/web-shared/lib/welcomeCredits';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { getCustomerInfo } from './customerInfo';

jest.mock('@kilocode/web-shared/lib/tokens', () => ({ generateApiToken: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  hasPaymentMethodInStripe: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/creditTransactions', () => ({
  summarizeUserPayments: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  userHasOrganizations: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/welcomeCredits', () => ({
  hasReceivedAnyFreeWelcomeCredits: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { query: { payment_methods: { findFirst: jest.fn() } } },
}));

const mockGenerateApiToken = jest.mocked(generateApiToken);
const mockHasPaymentMethodInStripe = jest.mocked(hasPaymentMethodInStripe);
const mockSummarizeUserPayments = jest.mocked(summarizeUserPayments);
const mockUserHasOrganizations = jest.mocked(userHasOrganizations);
const mockHasReceivedAnyFreeWelcomeCredits = jest.mocked(hasReceivedAnyFreeWelcomeCredits);
const mockFindFirst = jest.mocked(db.query.payment_methods.findFirst);

const testUser = { id: 'user-1', stripe_customer_id: 'cus_1' };

describe('getCustomerInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFirst.mockResolvedValue(undefined);
    mockHasPaymentMethodInStripe.mockResolvedValue(false);
    mockSummarizeUserPayments.mockResolvedValue({
      payments_count: 0,
      payments_total_microdollars: 0,
    });
    mockUserHasOrganizations.mockResolvedValue(false);
    mockHasReceivedAnyFreeWelcomeCredits.mockResolvedValue(false);
  });

  it('does not issue an API token', async () => {
    const customerInfo = await getCustomerInfo(testUser as never, {});

    expect(customerInfo).not.toHaveProperty('kiloToken');
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('reports the payment-method answers of every read', async () => {
    mockHasPaymentMethodInStripe.mockResolvedValue(true);
    mockFindFirst.mockResolvedValue({ id: 1 } as never);

    const customerInfo = await getCustomerInfo(testUser as never, {});

    expect(customerInfo.hasStripePaymentMethod).toBe(true);
    expect(customerInfo.hasPaymentMethodEligibleForFreeCredits).toBe(true);
    expect(mockHasPaymentMethodInStripe).toHaveBeenCalledWith({ stripeCustomerId: 'cus_1' });
  });

  // Regression: the Stripe lookup used to run outside the awaited group and was
  // awaited only while the result was built, so its rejection had no handler
  // until then and the caller saw nothing while the other reads were pending.
  it('settles a rejected Stripe lookup without waiting for the other reads', async () => {
    const { promise: pendingSummary } = Promise.withResolvers<{
      payments_count: number;
      payments_total_microdollars: number;
    }>();
    mockSummarizeUserPayments.mockReturnValue(pendingSummary);
    mockHasPaymentMethodInStripe.mockRejectedValue(new Error('Stripe is unavailable'));

    await expect(getCustomerInfo(testUser as never, {})).rejects.toThrow('Stripe is unavailable');
  });
});

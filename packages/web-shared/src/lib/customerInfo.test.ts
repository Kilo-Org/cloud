const mockGenerateApiToken = jest.fn();
const mockFindFirst = jest.fn();

jest.mock('@kilocode/web-shared/lib/tokens', () => ({ generateApiToken: mockGenerateApiToken }));
jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  hasPaymentMethodInStripe: jest.fn(() => false),
}));
jest.mock('@kilocode/web-shared/lib/creditTransactions', () => ({
  summarizeUserPayments: jest.fn(() => ({ payments_count: 0 })),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  userHasOrganizations: jest.fn(() => false),
}));
jest.mock('@kilocode/web-shared/lib/welcomeCredits', () => ({
  hasReceivedAnyFreeWelcomeCredits: jest.fn(() => false),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { query: { payment_methods: { findFirst: mockFindFirst } } },
}));

describe('getCustomerInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFirst.mockResolvedValue(undefined);
  });

  it('does not issue an API token', async () => {
    const { getCustomerInfo } = await import('./customerInfo');

    const customerInfo = await getCustomerInfo(
      { id: 'user-1', stripe_customer_id: null } as never,
      {}
    );

    expect(customerInfo).not.toHaveProperty('kiloToken');
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });
});

const mockGenerateApiToken = jest.fn();
const mockFindFirst = jest.fn();

jest.mock('@/lib/tokens', () => ({ generateApiToken: mockGenerateApiToken }));
jest.mock('@/lib/stripe-client', () => ({ hasPaymentMethodInStripe: jest.fn(() => false) }));
jest.mock('@/lib/creditTransactions', () => ({
  summarizeUserPayments: jest.fn(() => ({ payments_count: 0 })),
}));
jest.mock('@/lib/organizations/organizations', () => ({
  userHasOrganizations: jest.fn(() => false),
}));
jest.mock('@/lib/welcomeCredits', () => ({
  hasReceivedAnyFreeWelcomeCredits: jest.fn(() => false),
}));
jest.mock('@/lib/drizzle', () => ({
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

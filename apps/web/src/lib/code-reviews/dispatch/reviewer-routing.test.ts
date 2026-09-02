import { selectReviewerBackend, type ReviewerRoutingContext } from './reviewer-routing';

jest.mock('@/lib/posthog', () => {
  const client = { getFeatureFlag: jest.fn(), getFeatureFlagPayload: jest.fn() };
  return { __esModule: true, default: () => client, shutdownPosthog: jest.fn(), client };
});
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  startSpan: (_context: unknown, run: () => Promise<unknown>) => run(),
}));

const { client }: { client: { getFeatureFlag: jest.Mock; getFeatureFlagPayload: jest.Mock } } =
  jest.requireMock('@/lib/posthog');
const mockGetFeatureFlag = client.getFeatureFlag;
const mockGetFeatureFlagPayload = client.getFeatureFlagPayload;
const organizationId = '3d4a1f18-69cc-44ba-971e-04e9d9784e03';
const eligible: ReviewerRoutingContext = {
  platform: 'github',
  organizationId,
  reviewType: 'standard',
  outputMode: 'provider',
};

beforeEach(() => {
  mockGetFeatureFlag.mockReset().mockResolvedValue(true);
  mockGetFeatureFlagPayload.mockReset().mockResolvedValue({ organizationIds: [organizationId] });
});

it('selects isolate only for exact membership of eligible work', async () => {
  await expect(selectReviewerBackend(eligible)).resolves.toBe('isolate');
  await expect(
    selectReviewerBackend({ ...eligible, organizationId: '8e324f8b-adc1-46e6-9ef6-1c1034be7282' })
  ).resolves.toBe('legacy');
});

it.each<Partial<ReviewerRoutingContext>>([
  { platform: 'gitlab' },
  { platform: 'bitbucket' },
  { platform: undefined },
  { organizationId: null },
  { organizationId: '' },
  { organizationId: 'oauth/github/personal-user' },
  { reviewType: 'council' },
  { reviewType: undefined },
  { outputMode: 'kilo' },
  { outputMode: undefined },
])('short-circuits ineligible context %j', async overrides => {
  await expect(selectReviewerBackend({ ...eligible, ...overrides })).resolves.toBe('legacy');
  expect(mockGetFeatureFlag).not.toHaveBeenCalled();
  expect(mockGetFeatureFlagPayload).not.toHaveBeenCalled();
});

it.each([false, undefined, null, 'true', 'enabled', 1])(
  'does not route on non-true flag %j',
  async flag => {
    mockGetFeatureFlag.mockResolvedValue(flag);
    await expect(selectReviewerBackend(eligible)).resolves.toBe('legacy');
    expect(mockGetFeatureFlagPayload).not.toHaveBeenCalled();
  }
);

it.each([
  undefined,
  null,
  {},
  [],
  { organizationIds: [] },
  { organizationIds: organizationId },
  { organizationIds: [organizationId, 'bad-id'] },
  { organizationIds: [organizationId, 1] },
  { organizationIds: [organizationId], unexpected: true },
])('fails closed on unusable payload %j', async payload => {
  mockGetFeatureFlagPayload.mockResolvedValue(payload);
  await expect(selectReviewerBackend(eligible)).resolves.toBe('legacy');
});

it.each(['flag', 'payload'])('fails closed on %s read failure', async operation => {
  (operation === 'flag' ? mockGetFeatureFlag : mockGetFeatureFlagPayload).mockRejectedValue(
    new Error('unavailable')
  );
  await expect(selectReviewerBackend(eligible)).resolves.toBe('legacy');
});

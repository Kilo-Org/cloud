import { isCloudDataExportUIEnabled } from './user-data-export-ui';

jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: () => ({ getFeatureFlag: (...args: unknown[]) => mockGetFeatureFlag(...args) }),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  startSpan: async (_context: unknown, callback: () => Promise<unknown>) => callback(),
}));

const mockGetFeatureFlag = jest.fn();

describe('cloud data export UI flag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the same email distinct ID as browser PostHog identification', async () => {
    mockGetFeatureFlag.mockResolvedValue(true);

    await expect(isCloudDataExportUIEnabled('export-user@example.com')).resolves.toBe(true);
    expect(mockGetFeatureFlag).toHaveBeenCalledWith(
      'cloud-data-export-ui',
      'export-user@example.com'
    );
  });

  it.each([false, undefined, 'enabled'])('fails closed for %s', async value => {
    mockGetFeatureFlag.mockResolvedValue(value);

    await expect(isCloudDataExportUIEnabled('export-user@example.com')).resolves.toBe(false);
  });

  it('fails closed on PostHog errors', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetFeatureFlag.mockRejectedValue(new Error('PostHog unavailable'));

    try {
      await expect(isCloudDataExportUIEnabled('export-user@example.com')).resolves.toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not fall back to an anonymous or shared identity', async () => {
    await expect(isCloudDataExportUIEnabled('')).resolves.toBe(false);
    expect(mockGetFeatureFlag).not.toHaveBeenCalled();
  });

  it('does not bypass the flag in development', async () => {
    const env = jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development' });
    mockGetFeatureFlag.mockResolvedValue(undefined);

    try {
      await expect(isCloudDataExportUIEnabled('export-user@example.com')).resolves.toBe(false);
      expect(mockGetFeatureFlag).toHaveBeenCalled();
    } finally {
      env.restore();
    }
  });
});

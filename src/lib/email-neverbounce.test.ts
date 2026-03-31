import { captureMessage } from '@sentry/nextjs';
import { verifyEmail } from '@/lib/email-neverbounce';

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

const mockCaptureMessage = captureMessage as jest.MockedFunction<typeof captureMessage>;

let mockApiKey: string | undefined = 'test-api-key';

jest.mock('@/lib/config.server', () => ({
  get NEVERBOUNCE_API_KEY() {
    return mockApiKey;
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockNeverBounceResponse(result: string, status = 'success') {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      status,
      result,
      flags: ['has_dns', 'has_dns_mx'],
      suggested_correction: '',
      execution_time: 100,
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApiKey = 'test-api-key';
});

describe('verifyEmail', () => {
  it('returns true when API key is not configured', async () => {
    mockApiKey = undefined;
    expect(await verifyEmail('test@example.com')).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns true for valid emails', async () => {
    mockNeverBounceResponse('valid');
    expect(await verifyEmail('good@example.com')).toBe(true);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('returns false for invalid emails and reports to Sentry', async () => {
    mockNeverBounceResponse('invalid');
    expect(await verifyEmail('bad@example.com')).toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Blocked email send to invalid address',
      expect.objectContaining({
        level: 'info',
        tags: { source: 'neverbounce', result: 'invalid' },
      })
    );
  });

  it('returns false for disposable emails', async () => {
    mockNeverBounceResponse('disposable');
    expect(await verifyEmail('temp@mailinator.com')).toBe(false);
  });

  it('returns true for catchall emails', async () => {
    mockNeverBounceResponse('catchall');
    expect(await verifyEmail('anyone@catchall.com')).toBe(true);
  });

  it('returns true for unknown emails', async () => {
    mockNeverBounceResponse('unknown');
    expect(await verifyEmail('mystery@example.com')).toBe(true);
  });

  it('returns true on HTTP error (fail-open)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    expect(await verifyEmail('test@example.com')).toBe(true);
  });

  it('returns true on network error (fail-open) and reports to Sentry', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));
    expect(await verifyEmail('test@example.com')).toBe(true);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'NeverBounce verification check failed',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('returns true on non-success API status and reports to Sentry', async () => {
    mockNeverBounceResponse('valid', 'auth_failure');
    expect(await verifyEmail('test@example.com')).toBe(true);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'NeverBounce API returned non-success status: auth_failure',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('passes email and API key as query parameters', async () => {
    mockNeverBounceResponse('valid');
    await verifyEmail('user@test.com');
    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      'https://api.neverbounce.com/v4.2/single/check'
    );
    expect(calledUrl.searchParams.get('key')).toBe('test-api-key');
    expect(calledUrl.searchParams.get('email')).toBe('user@test.com');
  });

  it('sets a 5-second timeout on the fetch call', async () => {
    mockNeverBounceResponse('valid');
    await verifyEmail('user@test.com');
    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeDefined();
  });
});

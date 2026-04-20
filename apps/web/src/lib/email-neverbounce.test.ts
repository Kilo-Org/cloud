import { captureMessage } from '@sentry/nextjs';
import { checkEmailWithNeverBounce, verifyEmail } from '@/lib/email-neverbounce';

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

const mockCaptureMessage = jest.mocked(captureMessage);

let mockApiKey: string | undefined = 'test-api-key';

jest.mock('@/lib/config.server', () => ({
  get NEVERBOUNCE_API_KEY() {
    return mockApiKey;
  },
}));

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
global.fetch = mockFetch;

function mockNeverBounceResponse(result: string, status = 'success') {
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        status,
        result,
        flags: ['has_dns', 'has_dns_mx'],
        suggested_correction: '',
        execution_time: 100,
      }),
      { status: 200 }
    )
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApiKey = 'test-api-key';
});

describe('checkEmailWithNeverBounce', () => {
  it('allows without checking when API key is not configured', async () => {
    mockApiKey = undefined;

    await expect(checkEmailWithNeverBounce('test@example.com')).resolves.toEqual({
      kind: 'allowed_without_check',
      reason: 'missing_api_key',
      shouldSend: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips NeverBounce for icloud.com emails', async () => {
    await expect(checkEmailWithNeverBounce('user@icloud.com')).resolves.toEqual({
      kind: 'allowed_without_check',
      reason: 'bypass_domain',
      shouldSend: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips NeverBounce for me.com emails', async () => {
    await expect(checkEmailWithNeverBounce('user@me.com')).resolves.toEqual({
      kind: 'allowed_without_check',
      reason: 'bypass_domain',
      shouldSend: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips NeverBounce for bypass domains regardless of case', async () => {
    await expect(checkEmailWithNeverBounce('user@ICLOUD.COM')).resolves.toEqual({
      kind: 'allowed_without_check',
      reason: 'bypass_domain',
      shouldSend: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not skip NeverBounce for non-bypass domains', async () => {
    mockNeverBounceResponse('valid');

    await expect(checkEmailWithNeverBounce('user@gmail.com')).resolves.toEqual(
      expect.objectContaining({
        kind: 'checked',
        result: 'valid',
        shouldSend: true,
      })
    );
    expect(mockFetch).toHaveBeenCalled();
  });

  it('returns a checked deliverable result for valid emails', async () => {
    mockNeverBounceResponse('valid');

    await expect(checkEmailWithNeverBounce('good@example.com')).resolves.toEqual({
      kind: 'checked',
      result: 'valid',
      status: 'success',
      flags: ['has_dns', 'has_dns_mx'],
      suggestedCorrection: null,
      shouldSend: true,
    });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('returns a checked blocked result for invalid emails and reports to Sentry', async () => {
    mockNeverBounceResponse('invalid');

    await expect(checkEmailWithNeverBounce('bad@example.com')).resolves.toEqual({
      kind: 'checked',
      result: 'invalid',
      status: 'success',
      flags: ['has_dns', 'has_dns_mx'],
      suggestedCorrection: null,
      shouldSend: false,
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Blocked email send to invalid address',
      expect.objectContaining({
        level: 'info',
        tags: { source: 'neverbounce', result: 'invalid' },
      })
    );
  });

  it('returns a checked blocked result for disposable emails', async () => {
    mockNeverBounceResponse('disposable');

    await expect(checkEmailWithNeverBounce('temp@mailinator.com')).resolves.toEqual(
      expect.objectContaining({
        kind: 'checked',
        result: 'disposable',
        shouldSend: false,
      })
    );
  });

  it('returns a checked deliverable result for catchall emails', async () => {
    mockNeverBounceResponse('catchall');

    await expect(checkEmailWithNeverBounce('anyone@catchall.com')).resolves.toEqual(
      expect.objectContaining({
        kind: 'checked',
        result: 'catchall',
        shouldSend: true,
      })
    );
  });

  it('returns a checked deliverable result for unknown emails', async () => {
    mockNeverBounceResponse('unknown');

    await expect(checkEmailWithNeverBounce('mystery@example.com')).resolves.toEqual(
      expect.objectContaining({
        kind: 'checked',
        result: 'unknown',
        shouldSend: true,
      })
    );
  });

  it('allows without checking on HTTP error', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 500 }));

    await expect(checkEmailWithNeverBounce('test@example.com')).resolves.toEqual({
      kind: 'allowed_without_check',
      reason: 'http_error',
      status: '500',
      shouldSend: true,
    });
  });

  it('allows without checking on network error and reports to Sentry', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    await expect(checkEmailWithNeverBounce('test@example.com')).resolves.toEqual({
      kind: 'allowed_without_check',
      reason: 'exception',
      error: 'fetch failed',
      shouldSend: true,
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'NeverBounce verification check failed',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('allows without checking on non-success API status and reports to Sentry', async () => {
    mockNeverBounceResponse('valid', 'auth_failure');

    await expect(checkEmailWithNeverBounce('test@example.com')).resolves.toEqual({
      kind: 'allowed_without_check',
      reason: 'non_success_status',
      status: 'auth_failure',
      shouldSend: true,
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'NeverBounce API returned non-success status: auth_failure',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('passes email and API key as query parameters', async () => {
    mockNeverBounceResponse('valid');

    await checkEmailWithNeverBounce('user@test.com');

    const calledUrlInput = mockFetch.mock.calls[0]?.[0];
    if (
      calledUrlInput === undefined ||
      (!(typeof calledUrlInput === 'string') && !(calledUrlInput instanceof URL))
    ) {
      throw new Error('Expected fetch to be called with a URL string');
    }

    const calledUrl = new URL(calledUrlInput);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      'https://api.neverbounce.com/v4.2/single/check'
    );
    expect(calledUrl.searchParams.get('key')).toBe('test-api-key');
    expect(calledUrl.searchParams.get('email')).toBe('user@test.com');
  });

  it('sets a 5-second timeout on the fetch call', async () => {
    mockNeverBounceResponse('valid');

    await checkEmailWithNeverBounce('user@test.com');

    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions?.signal).toBeDefined();
  });
});

describe('verifyEmail', () => {
  it('returns false for a blocked live result', async () => {
    mockNeverBounceResponse('invalid');

    await expect(verifyEmail('bad@example.com')).resolves.toBe(false);
  });

  it('returns true for allowed-without-check outcomes', async () => {
    mockApiKey = undefined;

    await expect(verifyEmail('test@example.com')).resolves.toBe(true);
  });
});

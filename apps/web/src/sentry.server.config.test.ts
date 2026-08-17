import { describe, test, expect } from '@jest/globals';
import type { Event } from '@sentry/nextjs';
import { APICallError } from 'ai';
import { isAIUsageLimitError, sanitizeSentryRequestData } from '../sentry.server.config';

describe('sanitizeSentryRequestData', () => {
  test('removes the GitHub OAuth state token from request URL and query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/api/integrations/github/callback?code=auth-code&state=raw-state-token&installation_id=12345',
        query_string: 'code=auth-code&state=raw-state-token&installation_id=12345',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(
      'https://app.kilo.sh/api/integrations/github/callback?code=auth-code&installation_id=12345'
    );
    expect(result.request?.query_string).toBe('code=auth-code&installation_id=12345');
  });

  test('keeps unrelated parameters when no state is present', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/api/integrations/github/callback?code=auth-code&installation_id=12345',
        query_string: 'code=auth-code&installation_id=12345',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(
      'https://app.kilo.sh/api/integrations/github/callback?code=auth-code&installation_id=12345'
    );
    expect(result.request?.query_string).toBe('code=auth-code&installation_id=12345');
  });

  test('removes state from an object-form query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/api/integrations/github/callback',
        query_string: { code: 'auth-code', state: 'raw-state-token' },
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toEqual({ code: 'auth-code' });
  });

  test('removes percent-encoded state keys from the request URL and query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/api/integrations/github/callback?code=auth-code&%73tate=raw-state-token',
        query_string: 'code=auth-code&%73tate=raw-state-token',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(
      'https://app.kilo.sh/api/integrations/github/callback?code=auth-code'
    );
    expect(result.request?.query_string).toBe('code=auth-code');
  });

  test('removes every duplicate and mixed-case state key while keeping encoded values', () => {
    const event: Event = {
      request: {
        query_string:
          'code=auth-code&state=first&STATE=second&state=third&st%61te=fourth&redirect=%2Fhome',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toBe('code=auth-code&redirect=%2Fhome');
  });

  test('removes mixed-case state keys from the request URL', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/api/integrations/github/callback?code=auth-code&State=token',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(
      'https://app.kilo.sh/api/integrations/github/callback?code=auth-code'
    );
  });

  test('removes mixed-case state keys from an object-form query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/api/integrations/github/callback',
        query_string: { code: 'auth-code', State: 'token' },
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toEqual({ code: 'auth-code' });
  });

  test('removes percent-encoded state keys from an array-form query string', () => {
    const event: Event = {
      request: {
        query_string: [
          ['code', 'auth-code'],
          ['%73tate', 'raw-state-token'],
          ['St%61te', 'second-token'],
        ],
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toEqual([['code', 'auth-code']]);
  });

  test('removes percent-encoded state keys from an object-form query string', () => {
    const event: Event = {
      request: {
        query_string: { code: 'auth-code', '%73tate': 'raw-state-token' },
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toEqual({ code: 'auth-code' });
  });

  test('sanitizes a relative request URL', () => {
    const event: Event = {
      request: {
        url: '/api/integrations/github/callback?code=auth-code&state=raw-state-token',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe('/api/integrations/github/callback?code=auth-code');
  });

  test('sanitizes a relative request URL with encoded keys while keeping the fragment', () => {
    const event: Event = {
      request: {
        url: '/api/integrations/github/callback?code=auth-code&%73tate=raw-state-token#fragment',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe('/api/integrations/github/callback?code=auth-code#fragment');
  });

  test('keeps a relative request URL without a query string untouched', () => {
    const event: Event = {
      request: {
        url: '/api/integrations/github/callback',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe('/api/integrations/github/callback');
  });

  test('removes the app flow installState bearer from the request URL and query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/github-app?organizationId=org_123&installState=abc-token-123&fromApp=1',
        query_string: 'organizationId=org_123&installState=abc-token-123&fromApp=1',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(
      'https://app.kilo.sh/github-app?organizationId=org_123&fromApp=1'
    );
    expect(result.request?.query_string).toBe('organizationId=org_123&fromApp=1');
  });

  test('removes percent-encoded installState keys from the request URL and query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/github-app?organizationId=org_123&%69nstallState=abc-token-123',
        query_string: 'organizationId=org_123&%69nstallState=abc-token-123',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe('https://app.kilo.sh/github-app?organizationId=org_123');
    expect(result.request?.query_string).toBe('organizationId=org_123');
  });

  test('removes installState from an object-form query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/github-app',
        query_string: { organizationId: 'org_123', installState: 'abc-token-123' },
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toEqual({ organizationId: 'org_123' });
  });

  test('removes percent-encoded installState keys from an array-form query string', () => {
    const event: Event = {
      request: {
        query_string: [
          ['organizationId', 'org_123'],
          ['%69nstallState', 'abc-token-123'],
        ],
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toEqual([['organizationId', 'org_123']]);
  });

  test('removes both state and installState while keeping unrelated parameters', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/github-app?organizationId=org_123&installState=abc-token-123&state=oauth-token&fromApp=1',
        query_string:
          'organizationId=org_123&installState=abc-token-123&state=oauth-token&fromApp=1',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(
      'https://app.kilo.sh/github-app?organizationId=org_123&fromApp=1'
    );
    expect(result.request?.query_string).toBe('organizationId=org_123&fromApp=1');
  });

  test('sanitizes a relative request URL with an installState bearer', () => {
    const event: Event = {
      request: {
        url: '/github-app?organizationId=org_123&installState=abc-token-123&fromApp=1',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe('/github-app?organizationId=org_123&fromApp=1');
  });

  test('returns an event without request data untouched', () => {
    const event: Event = { message: 'no request data' };

    expect(sanitizeSentryRequestData(event)).toBe(event);
  });
});

describe('isAIUsageLimitError', () => {
  function apiCallError(statusCode: number): APICallError {
    return new APICallError({
      message: 'Add credits to continue, or switch to a free model',
      url: 'https://app.kilo.sh/api/openrouter/chat/completions',
      requestBodyValues: {},
      statusCode,
    });
  }

  test('matches a real AI SDK APICallError with statusCode 402', () => {
    expect(isAIUsageLimitError(apiCallError(402))).toBe(true);
  });

  test('does not match AI SDK call failures with other statuses', () => {
    expect(isAIUsageLimitError(apiCallError(429))).toBe(false);
    expect(isAIUsageLimitError(apiCallError(500))).toBe(false);
  });

  test('does not match an AI SDK call failure without a status', () => {
    const error = new APICallError({
      message: 'network failure',
      url: 'https://app.kilo.sh/api/openrouter/chat/completions',
      requestBodyValues: {},
    });

    expect(isAIUsageLimitError(error)).toBe(false);
  });

  test('does not match a 402 error that is not an AI SDK call error', () => {
    const error = Object.assign(new Error('payment required'), { statusCode: 402 });

    expect(isAIUsageLimitError(error)).toBe(false);
  });

  test('does not match plain errors or non-error values', () => {
    expect(isAIUsageLimitError(new Error('Add credits to continue'))).toBe(false);
    expect(isAIUsageLimitError({ name: 'AI_APICallError', statusCode: 402 })).toBe(false);
    expect(isAIUsageLimitError(undefined)).toBe(false);
  });
});

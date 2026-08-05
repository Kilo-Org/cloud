import { describe, test, expect } from '@jest/globals';
import type { Event } from '@sentry/nextjs';
import { sanitizeSentryRequestData } from '../sentry.server.config';

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

  test('returns an event without request data untouched', () => {
    const event: Event = { message: 'no request data' };

    expect(sanitizeSentryRequestData(event)).toBe(event);
  });
});

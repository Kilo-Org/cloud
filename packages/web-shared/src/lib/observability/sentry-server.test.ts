import { describe, test, expect } from '@jest/globals';
import type { Event } from '@sentry/nextjs';
import { sanitizeSentryRequestData } from '@kilocode/web-shared/lib/observability/sentry-server';
import {
  SENSITIVE_PATHS,
  SENSITIVE_QUERY_PARAMS,
} from '@kilocode/web-shared/lib/sanitize-analytics-url';

const SHARED_QUERY_KEYS = Array.from(SENSITIVE_QUERY_PARAMS);
const SHARED_PATHS = Array.from(SENSITIVE_PATHS);

const CALLBACK_URL = 'https://app.kilo.sh/api/integrations/github/callback?installation_id=12345';

describe('sanitizeSentryRequestData', () => {
  test.each(SHARED_QUERY_KEYS)(
    'removes the %s key from an absolute request URL and string query',
    key => {
      const event: Event = {
        request: {
          url: `${CALLBACK_URL}&${key}=sensitive`,
          query_string: `installation_id=12345&${key}=sensitive`,
          method: 'GET',
        },
      };

      const result = sanitizeSentryRequestData(event);

      expect(result.request?.url).toBe(CALLBACK_URL);
      expect(result.request?.query_string).toBe('installation_id=12345');
    }
  );

  test.each(SHARED_QUERY_KEYS)('removes the %s key from a relative request URL', key => {
    const event: Event = {
      request: {
        url: `/api/integrations/github/callback?${key}=sensitive&installation_id=12345`,
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe('/api/integrations/github/callback?installation_id=12345');
  });

  test.each(SHARED_QUERY_KEYS)(
    'removes mixed-case and percent-encoded %s keys from request metadata',
    key => {
      const upperCase = key.toUpperCase();
      const percentEncoded = `%${key.charCodeAt(0).toString(16)}${key.slice(1)}`;
      const event: Event = {
        request: {
          url: `${CALLBACK_URL}&${upperCase}=sensitive&${percentEncoded}=sensitive`,
          query_string: `installation_id=12345&${upperCase}=sensitive&${percentEncoded}=sensitive`,
          method: 'GET',
        },
      };

      const result = sanitizeSentryRequestData(event);

      expect(result.request?.url).toBe(CALLBACK_URL);
      expect(result.request?.query_string).toBe('installation_id=12345');
    }
  );

  test('removes every shared policy key from object-form and array-form query strings', () => {
    for (const key of SHARED_QUERY_KEYS) {
      const objectForm: Event = {
        request: {
          url: 'https://app.kilo.sh/api/integrations/github/callback',
          query_string: { installation_id: '12345', [key]: 'sensitive' },
        },
      };
      const arrayForm: Event = {
        request: {
          query_string: [
            ['installation_id', '12345'],
            [key, 'sensitive'],
          ],
          method: 'GET',
        },
      };

      expect(sanitizeSentryRequestData(objectForm).request?.query_string).toEqual({
        installation_id: '12345',
      });
      expect(sanitizeSentryRequestData(arrayForm).request?.query_string).toEqual([
        ['installation_id', '12345'],
      ]);
    }
  });

  test.each(SHARED_PATHS)('drops the whole URL query string on the %s path', path => {
    const event: Event = {
      request: {
        url: `https://app.kilo.sh${path}?email=user%40example.com&tab=usage`,
        query_string: 'email=user%40example.com&tab=usage',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(`https://app.kilo.sh${path}`);
    // The standalone query string carries no path context, so only the shared
    // sensitive keys are removed there.
    expect(result.request?.query_string).toBe('tab=usage');
  });

  test.each(SHARED_PATHS)(
    'drops the query string on a relative %s path while keeping the fragment',
    path => {
      const event: Event = {
        request: {
          url: `${path}?email=user%40example.com&tab=usage#done`,
          method: 'GET',
        },
      };

      const result = sanitizeSentryRequestData(event);

      expect(result.request?.url).toBe(`${path}#done`);
    }
  );

  test('keeps unrelated parameters', () => {
    const event: Event = {
      request: {
        url: CALLBACK_URL,
        query_string: 'installation_id=12345',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(CALLBACK_URL);
    expect(result.request?.query_string).toBe('installation_id=12345');
  });

  test('removes duplicate and mixed-case keys while keeping encoded values', () => {
    const event: Event = {
      request: {
        query_string:
          'installation_id=12345&state=first&STATE=second&state=third&st%61te=fourth&redirect=%2Fhome',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toBe('installation_id=12345&redirect=%2Fhome');
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

  test('removes the app flow installState value from the request URL and query string', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/github-app?organizationId=org_123&installState=hidden-value&fromApp=1',
        query_string: 'organizationId=org_123&installState=hidden-value&fromApp=1',
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
        url: 'https://app.kilo.sh/github-app?organizationId=org_123&%69nstallState=hidden-value',
        query_string: 'organizationId=org_123&%69nstallState=hidden-value',
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
        query_string: { organizationId: 'org_123', installState: 'hidden-value' },
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
          ['%69nstallState', 'hidden-value'],
        ],
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.query_string).toEqual([['organizationId', 'org_123']]);
  });

  test('removes both a shared policy key and installState while keeping unrelated parameters', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/github-app?organizationId=org_123&installState=hidden-value&state=hidden-state&fromApp=1',
        query_string:
          'organizationId=org_123&installState=hidden-value&state=hidden-state&fromApp=1',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe(
      'https://app.kilo.sh/github-app?organizationId=org_123&fromApp=1'
    );
    expect(result.request?.query_string).toBe('organizationId=org_123&fromApp=1');
  });

  test('sanitizes a relative request URL with an installState value', () => {
    const event: Event = {
      request: {
        url: '/github-app?organizationId=org_123&installState=hidden-value&fromApp=1',
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

  test('redacts a session share token from an absolute request URL', () => {
    const event: Event = {
      request: {
        url: 'https://app.kilo.sh/s/eyJhbGciOiJIUzI1NiJ9.share.token?utm_source=copy',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe('https://app.kilo.sh/s/:share_token?utm_source=copy');
  });

  test('redacts a session share token from a relative request URL while keeping the fragment', () => {
    const event: Event = {
      request: {
        url: '/s/eyJhbGciOiJIUzI1NiJ9.share.token#open',
        method: 'GET',
      },
    };

    const result = sanitizeSentryRequestData(event);

    expect(result.request?.url).toBe('/s/:share_token#open');
  });
});

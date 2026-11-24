import { describe, expect, jest, test } from '@jest/globals';
import type { Event, Integration } from '@sentry/nextjs';
import {
  expectScrubbedServerEvent,
  leakyServerEvent,
} from '@kilocode/web-shared/tests/helpers/sentry-event.helper';

type BeforeSend = (event: Event) => Event | null;
type EdgeOptions = { beforeSend: BeforeSend; integrations?: Integration[] };

// The edge initializer calls `init` at module scope, so each test loads a fresh
// copy of the real config module against a stubbed SDK and reads the options it
// registered.
async function loadEdgeOptions(): Promise<EdgeOptions> {
  const initMock = jest.fn();
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@sentry/nextjs', () => ({
      init: initMock,
      consoleLoggingIntegration: jest.fn(() => ({ name: 'ConsoleLogs' })),
      httpIntegration: jest.fn(() => ({ name: 'Http' })),
    }));
    await import('../../../sentry.edge.config');
  });

  expect(initMock).toHaveBeenCalledTimes(1);
  const options = initMock.mock.calls[0]?.[0] as Partial<EdgeOptions>;
  expect(typeof options.beforeSend).toBe('function');
  return options as EdgeOptions;
}

async function loadEdgeBeforeSend(): Promise<BeforeSend> {
  return (await loadEdgeOptions()).beforeSend;
}

describe('edge Sentry initializer request data', () => {
  test('applies the request data policy to the request URL and query string', async () => {
    const beforeSend = await loadEdgeBeforeSend();

    const result = beforeSend({
      request: {
        url: 'https://app.kilo.sh/github-app?organizationId=org_123&installState=abc-token-123&state=oauth-token&fromApp=1',
        query_string:
          'organizationId=org_123&installState=abc-token-123&state=oauth-token&fromApp=1',
        method: 'GET',
      },
    });

    expect(result?.request?.url).toBe(
      'https://app.kilo.sh/github-app?organizationId=org_123&fromApp=1'
    );
    expect(result?.request?.query_string).toBe('organizationId=org_123&fromApp=1');
  });

  test('applies the request data policy to a relative request URL and keeps the fragment', async () => {
    const beforeSend = await loadEdgeBeforeSend();

    const result = beforeSend({
      request: {
        url: '/github-app?organizationId=org_123&state=oauth-token#step-2',
        method: 'GET',
      },
    });

    expect(result?.request?.url).toBe('/github-app?organizationId=org_123#step-2');
  });

  test('applies the request data policy to object-form and array-form query strings', async () => {
    const beforeSend = await loadEdgeBeforeSend();

    const objectForm = beforeSend({
      request: {
        url: 'https://app.kilo.sh/github-app',
        query_string: { organizationId: 'org_123', installState: 'abc-token-123' },
      },
    });
    const arrayForm = beforeSend({
      request: {
        query_string: [
          ['organizationId', 'org_123'],
          ['state', 'oauth-token'],
        ],
        method: 'GET',
      },
    });

    expect(objectForm?.request?.query_string).toEqual({ organizationId: 'org_123' });
    expect(arrayForm?.request?.query_string).toEqual([['organizationId', 'org_123']]);
  });

  test('redacts a session share path', async () => {
    const beforeSend = await loadEdgeBeforeSend();

    const result = beforeSend({
      request: {
        url: 'https://app.kilo.sh/s/eyJhbGciOiJIUzI1NiJ9.share.token?utm_source=copy',
        method: 'GET',
      },
    });

    expect(result?.request?.url).toBe('https://app.kilo.sh/s/:share_token?utm_source=copy');
  });

  test('filters the forwarded search header', async () => {
    const beforeSend = await loadEdgeBeforeSend();

    const result = beforeSend({
      request: {
        headers: {
          'x-search': '?organizationId=org_123&installState=abc-token-123&fromApp=1',
          'x-pathname': '/s/eyJhbGciOiJIUzI1NiJ9.share.token',
        },
      },
    });

    expect(result?.request?.headers?.['x-search']).toBe('[Filtered]');
    expect(result?.request?.headers?.['x-pathname']).toBe('/s/:share_token');
  });

  test('keeps request data without the policy keys unchanged', async () => {
    const beforeSend = await loadEdgeBeforeSend();

    const result = beforeSend({
      request: {
        url: 'https://app.kilo.sh/github-app?organizationId=org_123&fromApp=1',
        query_string: 'organizationId=org_123&fromApp=1',
        method: 'GET',
      },
    });

    expect(result?.request?.url).toBe(
      'https://app.kilo.sh/github-app?organizationId=org_123&fromApp=1'
    );
    expect(result?.request?.query_string).toBe('organizationId=org_123&fromApp=1');
  });

  test('removes every credential from a realistic server event', async () => {
    const beforeSend = await loadEdgeBeforeSend();

    expectScrubbedServerEvent(beforeSend(leakyServerEvent()));
  });
});

describe('edge Sentry initializer logs', () => {
  test('sends no console output to Sentry', async () => {
    const options = await loadEdgeOptions();

    expect(options.integrations?.map(integration => integration.name) ?? []).not.toContain(
      'ConsoleLogs'
    );
  });
});

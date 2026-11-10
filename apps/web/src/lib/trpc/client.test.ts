import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { TRPCContext } from './client';
import { useRawTRPCClient } from './utils';

const mockFetch = jest.fn<typeof fetch>(async input => {
  const url = new URL(String(input), 'https://example.test');
  const result = { result: { data: [] } };
  return Response.json(
    url.searchParams.has('batch')
      ? url.pathname
          .split('/')
          .at(-1)
          ?.split(',')
          .map(() => result)
      : result
  );
});

describe('TRPCContext transport', () => {
  let root: Root;
  let queryClient: QueryClient;
  let client: ReturnType<typeof useRawTRPCClient>;
  let cleanup: () => void;

  beforeEach(async () => {
    mockFetch.mockClear();
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    const globals = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      EventSource: class extends EventTarget {},
      fetch: mockFetch,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };

    function Probe() {
      client = useRawTRPCClient();
      return null;
    }

    const container = document.getElementById('root');
    if (!container) throw new Error('Test root missing');
    const { createRoot } = await import('react-dom/client');
    root = createRoot(container);
    queryClient = new QueryClient();
    act(() =>
      root.render(
        createElement(QueryClientProvider, {
          client: queryClient,
          children: createElement(TRPCContext, { children: createElement(Probe) }),
        })
      )
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    queryClient?.clear();
    cleanup?.();
  });

  it.each([
    { label: 'without context', skipBatch: undefined },
    { label: 'with skipBatch=false', skipBatch: false },
    { label: 'with skipBatch=true', skipBatch: true },
  ])('sends 1,000 IDs per feature in a short POST request $label', async ({ skipBatch }) => {
    const input = {
      experimental_byok: Array.from({ length: 1000 }, () => crypto.randomUUID()),
      enkrypt_output_guardrail: Array.from({ length: 1000 }, () => crypto.randomUUID()),
      gateway_settings: Array.from({ length: 1000 }, () => crypto.randomUUID()),
      request_logs: Array.from({ length: 1000 }, () => crypto.randomUUID()),
    };

    if (skipBatch === undefined) {
      await client.admin.gatewayConfig.previewOrganizationFeatures.query(input);
    } else {
      await client.admin.gatewayConfig.previewOrganizationFeatures.query(input, {
        context: { skipBatch },
      });
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/trpc/admin.gatewayConfig.previewOrganizationFeatures');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual(input);
  });

  it('keeps normal queries as batched GET requests', async () => {
    await Promise.all([
      client.admin.gatewayConfig.getOrganizationFeatures.query(),
      client.admin.gatewayConfig.getOrganizationFeatures.query(),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [input, options] = mockFetch.mock.calls[0];
    const url = new URL(String(input), 'https://example.test');
    expect(url.pathname).toBe(
      '/api/trpc/admin.gatewayConfig.getOrganizationFeatures,admin.gatewayConfig.getOrganizationFeatures'
    );
    expect(options?.method).toBe('GET');
    expect(options?.body).toBeUndefined();
    expect(url.searchParams.get('batch')).toBe('1');
  });

  it('keeps skipBatch queries separate from normal batched GET requests', async () => {
    await Promise.all([
      client.admin.gatewayConfig.getOrganizationFeatures.query(),
      client.admin.gatewayConfig.getOrganizationFeatures.query(undefined, {
        context: { skipBatch: true },
      }),
      client.admin.gatewayConfig.getOrganizationFeatures.query(),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const requests = mockFetch.mock.calls.map(([input, options]) => {
      expect(options?.method).toBe('GET');
      expect(options?.body).toBeUndefined();
      return new URL(String(input), 'https://example.test');
    });
    const unbatched = requests.find(url => !url.searchParams.has('batch'));
    const batched = requests.find(url => url.searchParams.get('batch') === '1');
    expect(unbatched?.pathname).toBe('/api/trpc/admin.gatewayConfig.getOrganizationFeatures');
    expect(batched?.pathname).toBe(
      '/api/trpc/admin.gatewayConfig.getOrganizationFeatures,admin.gatewayConfig.getOrganizationFeatures'
    );
  });

  it('keeps unrelated queries on GET when methodOverride is POST', async () => {
    await client.admin.gatewayConfig.getOrganizationFeatures.query(undefined, {
      context: { methodOverride: 'POST' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [input, options] = mockFetch.mock.calls[0];
    const url = new URL(String(input), 'https://example.test');
    expect(url.pathname).toBe('/api/trpc/admin.gatewayConfig.getOrganizationFeatures');
    expect(url.searchParams.get('batch')).toBe('1');
    expect(options?.method).toBe('GET');
    expect(options?.body).toBeUndefined();
  });
});

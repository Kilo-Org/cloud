// Next's runtime reads `globalThis.AsyncLocalStorage` when it builds the request
// async stores, so the real patched fetch and its stores are loaded from this
// module registry only once that global exists. Jest hoists `jest.mock` calls
// above the imports, but it keeps the import order, so the assignment runs
// before the store modules load through `jest.requireActual` below.
globalThis.AsyncLocalStorage ??= require('node:async_hooks').AsyncLocalStorage;
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupFunction } from 'node:net';
import type * as NextWork from 'next/dist/server/app-render/work-async-storage.external';
import type * as NextUnit from 'next/dist/server/app-render/work-unit-async-storage.external';
import { lookup } from 'node:dns/promises';
import type { Agent as UndiciAgent, Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import { Agent } from 'undici';
import {
  clearUpstreamConnectionCache,
  lookupPinnedUpstreamAddress,
} from './upstream-connection';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

jest.resetModules();
const { createPatchedFetcher } = jest.requireActual<{
  createPatchedFetcher: (
    originFetch: typeof fetch,
    stores: { workAsyncStorage: typeof NextWork.workAsyncStorage; workUnitAsyncStorage: typeof NextUnit.workUnitAsyncStorage }
  ) => unknown;
}>('next/dist/server/lib/patch-fetch');
const { workAsyncStorage } = jest.requireActual<typeof NextWork>(
  'next/dist/server/app-render/work-async-storage.external'
);
const { workUnitAsyncStorage } = jest.requireActual<typeof NextUnit>(
  'next/dist/server/app-render/work-unit-async-storage.external'
);

const lookupMock = jest.mocked(
  lookup as unknown as (
    hostname: string,
    options: { all: true; verbatim: true }
  ) => Promise<Array<{ address: string; family: number }>>
);

/** Next's server fetch patch, built the way Next builds it over the global fetch. */
const patchedFetch = createPatchedFetcher(globalThis.fetch, {
  workAsyncStorage,
  workUnitAsyncStorage,
}) as typeof fetch;

/** The init type the gateway passes: an undici `dispatcher` beside the standard fields. */
type GatewayInit = RequestInit & { dispatcher?: Dispatcher };

function inRequestStore<T>(work: () => Promise<T>): Promise<T> {
  // The patch reads only the route and tracking fields of the work store; no
  // HTTP server is simulated.
  const store = { route: 'next-patch-guard.test' } as Parameters<
    typeof workAsyncStorage.run
  >[0];
  const unit = { type: 'request', phase: 'action' } as Parameters<
    typeof workUnitAsyncStorage.run
  >[0];
  return workAsyncStorage.run(store, () => workUnitAsyncStorage.run(unit, work));
}

function causeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined;
}

/** An undici Agent whose connect lookup is `lookup`, the shape the gateway builds. */
function agentFor(lookup: LookupFunction): UndiciAgent {
  return new Agent({ connect: { lookup } }) as UndiciAgent;
}

describe('the Next patched fetch forwards the pinned dispatcher to undici', () => {
  beforeEach(() => {
    clearUpstreamConnectionCache();
    lookupMock.mockReset();
  });

  it('serves a request through the dispatcher its init carries', async () => {
    const receivedHosts: string[] = [];
    const server = createServer((request, response) => {
      receivedHosts.push(request.headers.host ?? '');
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('pinned');
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const { port } = server.address() as AddressInfo;

    const lookedUp: string[] = [];
    const lookup: LookupFunction = (hostname, options, callback) => {
      lookedUp.push(hostname);
      if (options.all === true) {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
        return;
      }
      callback(null, '127.0.0.1', 4);
    };

    try {
      // A hostname no platform resolver answers: the request is served only if
      // the patch passed the dispatcher through to undici. A silent fallback
      // would fail the name resolution instead.
      const response = await inRequestStore(() =>
        patchedFetch(`http://next-patch-guard.test:${port}/`, {
          method: 'GET',
          dispatcher: agentFor(lookup),
        } as GatewayInit)
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('pinned');
      // The requested name stays the Host, and the connection used the lookup.
      expect(receivedHosts).toEqual([`next-patch-guard.test:${port}`]);
      expect(lookedUp).toContain('next-patch-guard.test');
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  });

  it('surfaces a refused pin as the verification failure, not a platform DNS answer', async () => {
    // The refresh of the absent pin fails, which is the refusal the production
    // lookup answers with. The dispatcher leaves with the error through its
    // connect lookup, so a silent fallback cannot substitute platform DNS.
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND refused-pin.test'));

    const error = await inRequestStore(() =>
      patchedFetch('https://refused-pin.test:9443/v1', {
        method: 'GET',
        dispatcher: agentFor(lookupPinnedUpstreamAddress),
      } as GatewayInit)
    ).then(
      () => null,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(TypeError);
    const cause = causeOf(error);
    expect(cause).toMatchObject({
      name: 'UpstreamAddressUnverifiedError',
      code: 'ERR_UPSTREAM_ADDRESS_UNVERIFIED',
    });
    expect(String((cause as Error).message)).toContain('refused-pin.test');
  });

  it('answers an init without a dispatcher with an unpatched fetch failure', async () => {
    await expect(
      inRequestStore(() => patchedFetch('http://127.0.0.1:9/x', { method: 'GET' }))
    ).rejects.toBeInstanceOf(TypeError);
  });
});

// The init type check keeps the spread of the gateway's `requestOptions` honest:
// the dispatcher reaches undici only because the patch rebuilds the init like this.
export type { UndiciAgent, UndiciRequestInit };

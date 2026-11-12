import type * as NextServer from 'next/server';
import type * as NextUnit from 'next/dist/server/app-render/work-unit-async-storage.external';
import type * as NextWork from 'next/dist/server/app-render/work-async-storage.external';
import type * as NextAfter from 'next/dist/server/after/after-context';
import type * as EnkryptUsage from './usage';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EnkryptUsageWriteSchema } from '@kilocode/usage-contracts';
import {
  enkryptLedgerRows,
  enkryptUsageRecordForNewOrganization,
} from '@kilocode/web-shared/tests/helpers/enkrypt-usage.helper';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: jest.fn(() => false),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  ENKRYPT_USAGE_QUEUE_ENABLED: true,
  USAGE_INGEST_URL: 'https://ingest.example.test/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-usage-ingest-secret',
}));

// Next's runtime reads this global when it builds the request async stores, so the real `after()`,
// its stores and the module under test are loaded from a fresh registry once it exists.
globalThis.AsyncLocalStorage = AsyncLocalStorage;
jest.resetModules();
const { AfterContext } = jest.requireActual<typeof NextAfter>(
  'next/dist/server/after/after-context'
);
const { workAsyncStorage } = jest.requireActual<typeof NextWork>(
  'next/dist/server/app-render/work-async-storage.external'
);
const { workUnitAsyncStorage } = jest.requireActual<typeof NextUnit>(
  'next/dist/server/app-render/work-unit-async-storage.external'
);
const { after: nextAfter } = jest.requireActual<typeof NextServer>('next/server');
const { recordEnkryptUsage } = jest.requireActual<typeof EnkryptUsage>('./usage');

const INGEST_URL = 'https://ingest.example.test/enkrypt-usage';
const NO_LIFETIME = '[enkrypt-guardrail] usage queue has no request lifetime; writing directly';
const nativeFetch = globalThis.fetch;
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;

function requestLifetime() {
  const pending: Promise<unknown>[] = [];
  const closeCallbacks: (() => void)[] = [];
  const errors: unknown[] = [];
  const afterContext = new AfterContext({
    waitUntil: promise => {
      pending.push(promise);
    },
    onClose: callback => {
      closeCallbacks.push(callback);
    },
    onTaskError: error => {
      errors.push(error);
    },
  });
  // AfterContext reads only the lifecycle fields of these stores; no HTTP server is simulated.
  const store = { afterContext } as Parameters<typeof workAsyncStorage.run>[0];
  const unit = { type: 'request', phase: 'action' } as Parameters<
    typeof workUnitAsyncStorage.run
  >[0];
  return {
    run: <T>(work: () => T): T =>
      workAsyncStorage.run(store, () => workUnitAsyncStorage.run(unit, work)),
    close: () => closeCallbacks.forEach(callback => callback()),
    drain: async () => {
      for (let i = 0; i < pending.length; i++) await pending[i];
    },
    errors,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => new Response(null, { status: 202 }));
  globalThis.fetch = mockFetch;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  jest.restoreAllMocks();
});

describe('recordEnkryptUsage with the real after()', () => {
  it('publishes from inside a gateway after() callback, as the guardrails call it', async () => {
    const usageRecord = await enkryptUsageRecordForNewOrganization();
    const lifecycle = requestLifetime();
    let settled = false;

    lifecycle.run(() =>
      nextAfter(async () => {
        await recordEnkryptUsage(usageRecord);
        settled = true;
      })
    );
    lifecycle.close();
    await lifecycle.drain();

    expect(settled).toBe(true);
    expect(lifecycle.errors).toEqual([]);
    const published = mockFetch.mock.calls.filter(([url]) => String(url) === INGEST_URL);
    expect(published).toHaveLength(1);
    expect(
      EnkryptUsageWriteSchema.safeParse(JSON.parse(String(published[0][1]?.body))).success
    ).toBe(true);
    expect(await enkryptLedgerRows(usageRecord.organizationId)).toEqual([]);
    expect(jest.mocked(console.warn).mock.calls.map(([message]) => message)).not.toContain(
      NO_LIFETIME
    );
  });

  it('writes directly, sending nothing, when called outside any request scope', async () => {
    const usageRecord = await enkryptUsageRecordForNewOrganization();

    await recordEnkryptUsage(usageRecord);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(await enkryptLedgerRows(usageRecord.organizationId)).toHaveLength(1);
    expect(jest.mocked(console.warn).mock.calls.map(([message]) => message)).toContain(NO_LIFETIME);
  });
});

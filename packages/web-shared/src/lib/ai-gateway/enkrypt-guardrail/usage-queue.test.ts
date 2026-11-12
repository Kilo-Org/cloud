const mockConfig: {
  ENKRYPT_USAGE_QUEUE_ENABLED: boolean;
  USAGE_INGEST_URL: string | undefined;
  USAGE_INGEST_PUBLISH_SECRET: string | undefined;
} = {
  ENKRYPT_USAGE_QUEUE_ENABLED: false,
  USAGE_INGEST_URL: undefined,
  USAGE_INGEST_PUBLISH_SECRET: undefined,
};
jest.mock('next/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: jest.fn(() => false),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  INTERNAL_API_SECRET: 'test-internal-secret',
  get ENKRYPT_USAGE_QUEUE_ENABLED() {
    return mockConfig.ENKRYPT_USAGE_QUEUE_ENABLED;
  },
  get USAGE_INGEST_URL() {
    return mockConfig.USAGE_INGEST_URL;
  },
  get USAGE_INGEST_PUBLISH_SECRET() {
    return mockConfig.USAGE_INGEST_PUBLISH_SECRET;
  },
}));
jest.mock('@kilocode/web-shared/lib/constants', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/constants'),
  APP_URL: 'https://app.example.com',
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { after } from 'next/server';
import { EnkryptUsageQueueMessageSchema, EnkryptUsageWriteSchema } from '@kilocode/usage-contracts';
import { isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import {
  enkryptLedgerRows,
  enkryptUsageRecordForNewOrganization,
} from '@kilocode/web-shared/tests/helpers/enkrypt-usage.helper';
import { recordEnkryptUsage } from './usage';

const INGEST_URL = 'https://ingest.example.test/enkrypt-usage';
const HANDOFF_URL = 'https://app.example.com/api/internal/enkrypt-usage/record';
const PUBLISH_SECRET = 'synthetic-usage-ingest-secret';
const DROPPED = '[enkrypt-guardrail] usage queue publication failed; record dropped';
const mockedAfter = jest.mocked(after);
const mockedIsUSRegion = jest.mocked(isUSRegion);
const nativeFetch = globalThis.fetch;
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;

function enableQueue(overrides: Partial<typeof mockConfig> = {}) {
  Object.assign(mockConfig, {
    ENKRYPT_USAGE_QUEUE_ENABLED: true,
    USAGE_INGEST_URL: 'https://ingest.example.test/usage',
    USAGE_INGEST_PUBLISH_SECRET: PUBLISH_SECRET,
    ...overrides,
  });
}

function callsTo(url: string) {
  return mockFetch.mock.calls.filter(([target]) => String(target) === url);
}

function publishedBodies() {
  return callsTo(INGEST_URL).map(([, init]) => JSON.parse(String(init?.body)) as unknown);
}

function droppedLogs() {
  return jest.mocked(console.error).mock.calls.filter(([message]) => message === DROPPED);
}

const regions = [
  ['Frankfurt', false],
  ['SFO', true],
] as const;

beforeEach(() => {
  Object.assign(mockConfig, {
    ENKRYPT_USAGE_QUEUE_ENABLED: false,
    USAGE_INGEST_URL: 'https://ingest.example.test/usage',
    USAGE_INGEST_PUBLISH_SECRET: PUBLISH_SECRET,
  });
  mockFetch.mockReset();
  mockedAfter.mockReset();
  globalThis.fetch = mockFetch;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  mockedIsUSRegion.mockReturnValue(false);
  jest.restoreAllMocks();
});

describe('recordEnkryptUsage with the usage queue flag off', () => {
  it('writes locally in Frankfurt and publishes nothing', async () => {
    const usageRecord = await enkryptUsageRecordForNewOrganization();

    await recordEnkryptUsage(usageRecord);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
    expect(await enkryptLedgerRows(usageRecord.organizationId)).toHaveLength(1);
  });

  it('hands off from SFO and publishes nothing', async () => {
    mockedIsUSRegion.mockReturnValue(true);
    mockFetch.mockResolvedValue(Response.json({ status: 'recorded' }));

    await recordEnkryptUsage(await enkryptUsageRecordForNewOrganization());

    expect(callsTo(HANDOFF_URL)).toHaveLength(1);
    expect(callsTo(INGEST_URL)).toEqual([]);
    expect(mockedAfter).not.toHaveBeenCalled();
  });
});

describe('recordEnkryptUsage with the usage queue flag on', () => {
  it.each(regions)(
    'publishes the bare write once from %s and neither hands off nor writes locally',
    async (_region, us) => {
      enableQueue();
      mockedIsUSRegion.mockReturnValue(us);
      mockFetch.mockImplementation(async () => new Response(null, { status: 202 }));
      const usageRecord = await enkryptUsageRecordForNewOrganization();
      const before = new Date().toISOString();

      await expect(recordEnkryptUsage(usageRecord)).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockedAfter).toHaveBeenCalledTimes(1);
      const [[, init]] = callsTo(INGEST_URL);
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${PUBLISH_SECRET}` },
      });
      const [body] = publishedBodies();
      const published = EnkryptUsageWriteSchema.parse(body);
      expect(body).toEqual({
        ...usageRecord,
        id: published.id,
        occurredAt: published.occurredAt,
      });
      expect(published.occurredAt >= before).toBe(true);
      expect(EnkryptUsageQueueMessageSchema.safeParse(body).success).toBe(false);
      expect(
        EnkryptUsageQueueMessageSchema.parse({ kind: 'enkrypt_usage', v: 1, record: body })
      ).toEqual({ kind: 'enkrypt_usage', v: 1, record: published });
      expect(await enkryptLedgerRows(usageRecord.organizationId)).toEqual([]);
      expect(droppedLogs()).toEqual([]);
    }
  );

  it.each(regions)(
    'drops the write from %s after a failed send, with one bounded log line',
    async (_region, us) => {
      enableQueue();
      mockedIsUSRegion.mockReturnValue(us);
      mockFetch.mockImplementation(async () => new Response(null, { status: 400 }));
      const usageRecord = await enkryptUsageRecordForNewOrganization();

      await expect(recordEnkryptUsage(usageRecord)).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(callsTo(HANDOFF_URL)).toEqual([]);
      expect(await enkryptLedgerRows(usageRecord.organizationId)).toEqual([]);
      const [published] = publishedBodies();
      expect(droppedLogs()).toEqual([
        [DROPPED, { usage_id: EnkryptUsageWriteSchema.parse(published).id, reason: 'http_400' }],
      ]);
    }
  );

  it('drops the write with the bounded line when the publisher rejects unexpectedly', async () => {
    enableQueue();
    mockFetch.mockImplementation(async () => new Response(null, { status: 400 }));
    jest.mocked(console.warn).mockImplementation(message => {
      if (message === 'usage enqueue unavailable')
        throw new RangeError('synthetic log sink failure');
    });
    const usageRecord = await enkryptUsageRecordForNewOrganization();

    await expect(recordEnkryptUsage(usageRecord)).resolves.toBeUndefined();

    expect(callsTo(INGEST_URL)).toHaveLength(1);
    expect(await enkryptLedgerRows(usageRecord.organizationId)).toEqual([]);
    const [published] = publishedBodies();
    expect(droppedLogs()).toEqual([
      [
        DROPPED,
        {
          usage_id: EnkryptUsageWriteSchema.parse(published).id,
          reason: 'unexpected_rejection',
          error_name: 'RangeError',
        },
      ],
    ]);
  });

  it('retries a transport failure with the same body, then drops it without a direct write', async () => {
    enableQueue();
    mockFetch.mockRejectedValue(new TypeError(`fetch failed ${INGEST_URL}`));
    const usageRecord = await enkryptUsageRecordForNewOrganization();
    jest.spyOn(Math, 'random').mockReturnValue(0);

    await recordEnkryptUsage(usageRecord);

    const bodies = callsTo(INGEST_URL).map(([, init]) => init?.body);
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies).size).toBe(1);
    expect(await enkryptLedgerRows(usageRecord.organizationId)).toEqual([]);
    expect(droppedLogs()).toHaveLength(1);
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(PUBLISH_SECRET);
    expect(JSON.stringify(droppedLogs())).not.toContain(usageRecord.kiloUserId);
  });

  it.each([
    ['no usage-ingest URL', { USAGE_INGEST_URL: undefined }],
    ['no publish secret', { USAGE_INGEST_PUBLISH_SECRET: undefined }],
    ['a scheme-less URL', { USAGE_INGEST_URL: 'ingest.example.test/usage' }],
    ['a URL not ending in /usage', { USAGE_INGEST_URL: 'https://ingest.example.test/proxy/usage' }],
    ['a URL with a query', { USAGE_INGEST_URL: 'https://ingest.example.test/usage?env=staging' }],
  ])('writes locally when the publisher has %s', async (_label, overrides) => {
    enableQueue(overrides);
    const usageRecord = await enkryptUsageRecordForNewOrganization();

    await recordEnkryptUsage(usageRecord);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(await enkryptLedgerRows(usageRecord.organizationId)).toHaveLength(1);
    expect(droppedLogs()).toEqual([]);
  });

  it('hands off from SFO when the publisher is not configured', async () => {
    enableQueue({ USAGE_INGEST_URL: undefined });
    mockedIsUSRegion.mockReturnValue(true);
    mockFetch.mockResolvedValue(Response.json({ status: 'recorded' }));

    await recordEnkryptUsage(await enkryptUsageRecordForNewOrganization());

    expect(callsTo(HANDOFF_URL)).toHaveLength(1);
    expect(callsTo(INGEST_URL)).toEqual([]);
  });
});

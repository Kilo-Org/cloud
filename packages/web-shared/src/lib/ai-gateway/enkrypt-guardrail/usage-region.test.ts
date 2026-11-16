jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: jest.fn(() => false),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  INTERNAL_API_SECRET: 'test-internal-secret',
}));
jest.mock('@kilocode/web-shared/lib/constants', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/constants'),
  APP_URL: 'https://app.example.com',
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import {
  enkryptLedgerRows,
  enkryptUsageRecordForNewOrganization,
  organizationMicrodollarsUsed,
} from '@kilocode/web-shared/tests/helpers/enkrypt-usage.helper';
import { MICRODOLLARS_PER_ENKRYPT_CREDIT, recordEnkryptUsage } from './usage';
import { EnkryptUsageWriteSchema } from '@kilocode/usage-contracts';
import { readJsonBody, requestUrlOf } from '@kilocode/web-shared/tests/helpers/request-body.helper';

const mockedIsUSRegion = jest.mocked(isUSRegion);
const nativeFetch = globalThis.fetch;
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  mockedIsUSRegion.mockReturnValue(false);
  jest.restoreAllMocks();
});

describe('recordEnkryptUsage region routing', () => {
  it('writes directly outside a US region', async () => {
    const usageRecord = await enkryptUsageRecordForNewOrganization();

    await recordEnkryptUsage(usageRecord);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(await enkryptLedgerRows(usageRecord.organizationId)).toHaveLength(1);
    expect(await organizationMicrodollarsUsed(usageRecord.organizationId)).toBe(
      7 * MICRODOLLARS_PER_ENKRYPT_CREDIT
    );
  });

  it('hands the write to the primary region from a US region', async () => {
    mockedIsUSRegion.mockReturnValue(true);
    mockFetch.mockResolvedValue(Response.json({ status: 'recorded' }));
    const usageRecord = await enkryptUsageRecordForNewOrganization({
      microdollarUsageId: randomUUID(),
    });

    await recordEnkryptUsage(usageRecord);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(requestUrlOf(url)).toBe('https://app.example.com/api/internal/enkrypt-usage/record');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'x-internal-api-key': 'test-internal-secret',
    });
    expect(readJsonBody(init?.body)).not.toHaveProperty('guardrail');
    const body = EnkryptUsageWriteSchema.parse(readJsonBody(init?.body));
    expect(body).toEqual({
      ...usageRecord,
      guardrail: 'input',
      id: expect.any(String),
      occurredAt: expect.any(String),
    });
    expect(await enkryptLedgerRows(usageRecord.organizationId)).toEqual([]);
    expect(await organizationMicrodollarsUsed(usageRecord.organizationId)).toBe(0);
  });

  it.each(['recorded', 'duplicate'])(
    'treats a %s response echoing the sent usage id as handled without writing locally',
    async status => {
      mockedIsUSRegion.mockReturnValue(true);
      mockFetch.mockImplementation(async (_url, init) =>
        Response.json({
          status,
          usageId: EnkryptUsageWriteSchema.parse(readJsonBody(init?.body)).id,
        })
      );
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const usageRecord = await enkryptUsageRecordForNewOrganization();

      await recordEnkryptUsage(usageRecord);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
      expect(await enkryptLedgerRows(usageRecord.organizationId)).toEqual([]);
      expect(await organizationMicrodollarsUsed(usageRecord.organizationId)).toBe(0);
    }
  );

  it.each([
    [
      'a transport failure',
      () => mockFetch.mockRejectedValue(new TypeError('fetch failed')),
      'TypeError',
    ],
    [
      'a timeout',
      () => mockFetch.mockRejectedValue(new DOMException('timed out', 'TimeoutError')),
      'TimeoutError',
    ],
    [
      'an unavailable endpoint',
      () => mockFetch.mockResolvedValue(new Response(null, { status: 503 })),
      'http_503',
    ],
    [
      'an authentication rejection',
      () => mockFetch.mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 })),
      'http_401',
    ],
    [
      'a malformed response',
      () => mockFetch.mockResolvedValue(Response.json({ status: 'unknown' })),
      'malformed_response',
    ],
    [
      'a response with an unknown field',
      () => mockFetch.mockResolvedValue(Response.json({ status: 'recorded', result: null })),
      'malformed_response',
    ],
    [
      'a response echoing a different usage id',
      () =>
        mockFetch.mockResolvedValue(Response.json({ status: 'recorded', usageId: randomUUID() })),
      'usage_id_mismatch',
    ],
  ])('logs %s without the secret and writes locally once', async (_name, arrange, reason) => {
    mockedIsUSRegion.mockReturnValue(true);
    arrange();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const usageRecord = await enkryptUsageRecordForNewOrganization({
      microdollarUsageId: randomUUID(),
    });

    await expect(recordEnkryptUsage(usageRecord)).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      '[enkrypt-guardrail] failed to record usage in the primary region; writing locally',
      { usage_id: expect.any(String), reason }
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('test-internal-secret');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const handedOff = EnkryptUsageWriteSchema.parse(readJsonBody(mockFetch.mock.calls[0][1]?.body));
    const rows = await enkryptLedgerRows(usageRecord.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(handedOff.id);
    expect(rows[0].microdollar_usage_id).toBe(usageRecord.microdollarUsageId);
    expect(new Date(rows[0].created_at).toISOString()).toBe(handedOff.occurredAt);
    expect(await organizationMicrodollarsUsed(usageRecord.organizationId)).toBe(
      7 * MICRODOLLARS_PER_ENKRYPT_CREDIT
    );
  });

  it.each([
    [
      'a failed body cancel on an error response',
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new TypeError('cancel failed with a detail that must not be logged');
            },
          }),
          { status: 503 }
        ),
      '[enkrypt-guardrail] failed to cancel the primary region error response body',
      'TypeError',
      'http_503',
    ],
    [
      'an unparseable success response',
      () => new Response('not json, with a detail that must not be logged', { status: 200 }),
      '[enkrypt-guardrail] failed to parse the primary region response body',
      'SyntaxError',
      'malformed_response',
    ],
    [
      'a success response body that times out while being read',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException('timed out with a detail that must not be logged', 'TimeoutError')
              );
            },
          }),
          { status: 200 }
        ),
      '[enkrypt-guardrail] failed to parse the primary region response body',
      'TimeoutError',
      'malformed_response',
    ],
  ])(
    'logs %s and still writes locally once',
    async (_name, response, warning, errorName, reason) => {
      mockedIsUSRegion.mockReturnValue(true);
      mockFetch.mockResolvedValue(response());
      const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const usageRecord = await enkryptUsageRecordForNewOrganization();

      await expect(recordEnkryptUsage(usageRecord)).resolves.toBeUndefined();

      const handedOff = EnkryptUsageWriteSchema.parse(
        readJsonBody(mockFetch.mock.calls[0][1]?.body)
      );
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(consoleWarn).toHaveBeenCalledWith(warning, {
        usage_id: handedOff.id,
        error_name: errorName,
      });
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('must not be logged');
      expect(consoleError).toHaveBeenCalledWith(
        '[enkrypt-guardrail] failed to record usage in the primary region; writing locally',
        { usage_id: handedOff.id, reason }
      );
      const rows = await enkryptLedgerRows(usageRecord.organizationId);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(handedOff.id);
      expect(await organizationMicrodollarsUsed(usageRecord.organizationId)).toBe(
        7 * MICRODOLLARS_PER_ENKRYPT_CREDIT
      );
    }
  );
});

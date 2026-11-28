import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import { buildGraderUsage, writeGraderUsage } from './grader-usage';

const createdAt = '2026-01-01T00:00:00.000Z';
const fetchMock = vi.fn<typeof fetch>();

function recorded(usage: UsageRecordRequest): Response {
  return Response.json({
    status: 'recorded',
    result: { usageId: usage.core.id, createdAt, newMicrodollarsUsed: 7 },
  });
}

function headersOfCall(index: number): Headers {
  return new Headers(fetchMock.mock.calls[index]?.[1]?.headers);
}

async function graderUsage(): Promise<UsageRecordRequest> {
  return buildGraderUsage(
    { userId: 'user-1', organizationId: null },
    ['case-a', 1],
    0.002,
    createdAt
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('writeGraderUsage', () => {
  it('posts with the internal secret while WEB_INTERNAL_AUTH is unset', async () => {
    const usage = await graderUsage();
    fetchMock.mockResolvedValueOnce(recorded(usage));
    const outcome = await writeGraderUsage(
      {
        KILO_WEB_API_BASE_URL: 'https://web.test',
        INTERNAL_API_SECRET_PROD: { get: async () => 'secret' } as unknown as SecretsStoreSecret,
      },
      usage
    );
    expect(outcome.kind).toBe('recorded');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://web.test/api/internal/usage/record');
    expect(headersOfCall(0).get('x-internal-api-key')).toBe('secret');
    expect(headersOfCall(0).has('authorization')).toBe(false);
  });

  it('presents a web:usage.benchmark-grader.record STS token under sts, never the secret', async () => {
    const usage = await graderUsage();
    fetchMock.mockResolvedValueOnce(recorded(usage));
    const secret = vi.fn(async () => 'secret');
    const minted: unknown[] = [];
    const outcome = await writeGraderUsage(
      {
        KILO_WEB_API_BASE_URL: 'https://web.test',
        INTERNAL_API_SECRET_PROD: { get: secret } as unknown as SecretsStoreSecret,
        WEB_INTERNAL_AUTH: 'sts',
        STS: {
          async mintTokens(request) {
            minted.push(request);
            return {
              status: 'ok',
              tokens: request.tokens.map(({ audience, scope }) => ({
                status: 'issued',
                audience,
                scope,
                token: 'sts-grader-token',
                jti: 'jti-grader',
                expiresAt: Math.floor(Date.now() / 1000) + 300,
              })),
            };
          },
        },
      },
      usage
    );
    expect(outcome.kind).toBe('recorded');
    expect(headersOfCall(0).get('authorization')).toBe('Bearer sts-grader-token');
    expect(headersOfCall(0).has('x-internal-api-key')).toBe(false);
    expect(secret).not.toHaveBeenCalled();
    expect(minted).toEqual([
      { tokens: [{ audience: 'web', scope: 'web:usage.benchmark-grader.record' }] },
    ]);
  });

  it('returns unavailable without a request when sts has no STS binding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage = await graderUsage();
    await expect(
      writeGraderUsage(
        {
          KILO_WEB_API_BASE_URL: 'https://web.test',
          INTERNAL_API_SECRET_PROD: { get: async () => 'unused' } as unknown as SecretsStoreSecret,
          WEB_INTERNAL_AUTH: 'sts',
        },
        usage
      )
    ).resolves.toEqual({ kind: 'unavailable', reason: 'missing_config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

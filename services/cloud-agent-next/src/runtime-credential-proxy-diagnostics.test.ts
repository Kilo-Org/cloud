import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LoggerModule from './logger.js';
import {
  logRuntimeProxyRequestFailed,
  parseUpstreamVercelRequestId,
} from './runtime-credential-proxy-diagnostics.js';

const { withFields, warn } = vi.hoisted(() => ({ withFields: vi.fn(), warn: vi.fn() }));
vi.mock('./logger.js', () => ({ logger: { withFields } }));

const fixture = {
  responseHeader: 'iad1::iad1::abc12-1700000000000-012345abcdef',
  nativeLogRequestId: 'abc12-1700000000000-012345abcdef',
};

beforeEach(() => {
  vi.clearAllMocks();
  withFields.mockReturnValue({ warn });
});

describe('parseUpstreamVercelRequestId', () => {
  it('replays the supported header/native log ID mapping with synthetic values', () => {
    expect(parseUpstreamVercelRequestId(fixture.responseHeader)).toBe(fixture.nativeLogRequestId);
  });

  it.each([
    undefined,
    null,
    44,
    {
      toString: () => {
        throw new Error('must not coerce');
      },
    },
    '',
    fixture.nativeLogRequestId,
    `iad1::${fixture.nativeLogRequestId}`,
    `iad1::iad1::iad1::${fixture.nativeLogRequestId}`,
    ` ${fixture.responseHeader}`,
    `${fixture.responseHeader}\n`,
    fixture.responseHeader.toUpperCase(),
    fixture.responseHeader.replace('iad1', 'iad0'),
    fixture.responseHeader.replace('abc12', 'abc_2'),
    fixture.responseHeader.replace('abcdef', 'abcdeg'),
    fixture.responseHeader.replace('1700000000000', '170000000000'),
    `${fixture.responseHeader}, ${fixture.responseHeader}`,
    `https://example.test/${fixture.responseHeader}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',
    'x'.repeat(100_000),
  ])('drops unsupported input %#', value => {
    expect(parseUpstreamVercelRequestId(value)).toBeUndefined();
    expect(withFields).not.toHaveBeenCalled();
  });
});

describe('logRuntimeProxyRequestFailed', () => {
  it('keeps the full failure payload below 2 KiB with 256-character correlation IDs', async () => {
    const { logger } = await vi.importActual<typeof LoggerModule>('./logger.js');
    withFields.mockImplementationOnce(fields => logger.withFields(fields));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logRuntimeProxyRequestFailed({
        upstreamAttempted: true,
        upstreamStatus: 401,
        upstreamVercelRequestId: parseUpstreamVercelRequestId(fixture.responseHeader),
        sessionId: 's'.repeat(256),
        kiloSessionId: 'k'.repeat(256),
        allocationId: 'a'.repeat(256),
        wrapperInstanceId: 'w'.repeat(256),
        connectionId: 'c'.repeat(256),
      });
      expect(withFields).toHaveBeenCalledOnce();
      expect(output).toHaveBeenCalledOnce();
      expect(output.mock.calls[0]?.[0]).toMatchObject({
        message: 'Runtime credential proxy request failed',
        level: 'warn',
        upstreamVercelRequestId: fixture.nativeLogRequestId,
      });
      expect(
        new TextEncoder().encode(JSON.stringify(output.mock.calls[0]?.[0])).byteLength
      ).toBeLessThanOrEqual(2048);
    } finally {
      output.mockRestore();
    }
  });

  it('does not include an upstream ID on a local rejection', () => {
    const input = {
      upstreamAttempted: false as const,
      rejectionStage: 'grant' as const,
      upstreamVercelRequestId: fixture.nativeLogRequestId,
    };
    logRuntimeProxyRequestFailed(input);
    expect(withFields).toHaveBeenCalledExactlyOnceWith({
      logTag: 'runtime_proxy_request_failed',
      upstreamAttempted: false,
      rejectionStage: 'grant',
    });
  });
});

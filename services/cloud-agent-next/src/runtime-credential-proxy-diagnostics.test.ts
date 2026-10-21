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

  it('parses a header whose region tokens differ', () => {
    expect(parseUpstreamVercelRequestId('iad1::sfo1::abc12-1700000000000-012345abcdef')).toBe(
      'abc12-1700000000000-012345abcdef'
    );
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
  it('adds only the bounded upstream ID to the real logger record', async () => {
    const { logger: realLogger, withLogTags } =
      await vi.importActual<typeof LoggerModule>('./logger.js');
    withFields.mockImplementation(fields => realLogger.withFields(fields));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers({ now: new Date('2026-02-01T00:10:42.000Z'), toFake: ['Date'] });
    try {
      const canonicalPath =
        '/api/runtime-credential-proxy/provider/api/openrouter/chat/completions';
      const correlation = {
        upstreamAttempted: true as const,
        upstreamStatus: 401,
        sessionId: 's'.repeat(256),
        kiloSessionId: 'k'.repeat(256),
        allocationId: 'a'.repeat(256),
        wrapperInstanceId: 'w'.repeat(256),
        connectionId: 'c'.repeat(256),
      };
      await withLogTags({ source: 'worker-entry' }, async () => {
        realLogger.setTags({ method: 'POST', path: canonicalPath });
        logRuntimeProxyRequestFailed({
          ...correlation,
          upstreamVercelRequestId: parseUpstreamVercelRequestId(fixture.responseHeader),
        });
        logRuntimeProxyRequestFailed(correlation);
      });

      expect(output).toHaveBeenCalledTimes(2);
      const enriched = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const baseline = output.mock.calls[1]?.[0] as Record<string, unknown>;
      const baselineTags = baseline.tags as { path?: string; $logger?: { level?: string } };
      expect(baselineTags.path).toBe(canonicalPath);
      expect(baselineTags.$logger?.level).toBe('debug');

      const addedId = enriched.upstreamVercelRequestId;
      const addedIdText = addedId as string;
      expect(addedIdText).toBe(fixture.nativeLogRequestId);
      expect(addedIdText).toHaveLength(32);
      expect([...addedIdText].every(char => char.charCodeAt(0) <= 0x7f)).toBe(true);

      expect(baseline).not.toHaveProperty('upstreamVercelRequestId');
      expect(enriched).toEqual({
        ...baseline,
        upstreamVercelRequestId: fixture.nativeLogRequestId,
      });
      expect(Object.keys(enriched)).toHaveLength(Object.keys(baseline).length + 1);

      const encoder = new TextEncoder();
      const enrichedJson = JSON.stringify(enriched);
      const baselineJson = JSON.stringify(baseline);
      expect(enrichedJson).toContain(fixture.nativeLogRequestId);
      expect(baselineJson).not.toContain(fixture.nativeLogRequestId);
      for (const serialized of [enrichedJson, baselineJson]) {
        expect(serialized).not.toContain(fixture.responseHeader);
        expect(serialized).not.toContain('iad1');
      }
      const growth =
        encoder.encode(enrichedJson).byteLength - encoder.encode(baselineJson).byteLength;
      expect(growth).toBe(61);
    } finally {
      output.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps only the native 32-character ID out of a valid header', () => {
    logRuntimeProxyRequestFailed({
      upstreamAttempted: true,
      upstreamStatus: 401,
      upstreamVercelRequestId: parseUpstreamVercelRequestId(
        'iad1::sfo1::abc12-1700000000000-012345abcdef'
      ),
      sessionId: 'agent_proxy',
      kiloSessionId: 'kilo_proxy',
    });

    const fields = withFields.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields.upstreamVercelRequestId).toBe('abc12-1700000000000-012345abcdef');
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain('iad1::sfo1::abc12-1700000000000-012345abcdef');
    expect(serialized).not.toContain('iad1');
    expect(serialized).not.toContain('sfo1');
  });

  it('keeps the original record without the new field for a poisoned header', () => {
    const poisoned = [
      {
        name: 'a duplicate header',
        header: 'iad1::iad1::abc12-1700000000000-012345abcdef, secret-duplicate',
        sentinel: 'secret-duplicate',
      },
      {
        name: 'a URL',
        header: 'https://secret-header.test/private',
        sentinel: 'secret-header.test',
      },
      { name: 'a bearer token', header: 'Bearer secret-token', sentinel: 'secret-token' },
      {
        name: 'a JWT',
        header: 'eyJhbGciOiJIUzI1NiJ9.secret-signature.signature',
        sentinel: 'secret-signature',
      },
      { name: 'an oversized value', header: 'x'.repeat(4096), sentinel: 'x'.repeat(64) },
      {
        name: 'surrounding whitespace',
        header: ' iad1::sfo1::abc12-1700000000000-012345abcdef ',
        sentinel: 'iad1::sfo1::',
      },
      {
        name: 'a missing region',
        header: 'sfo1::abc12-1700000000000-012345abcdef',
        sentinel: 'sfo1::abc12',
      },
    ];

    for (const { header } of poisoned) {
      logRuntimeProxyRequestFailed({
        upstreamAttempted: true,
        upstreamStatus: 401,
        upstreamVercelRequestId: parseUpstreamVercelRequestId(header),
        sessionId: 'agent_proxy',
        kiloSessionId: 'kilo_proxy',
      });
    }

    expect(withFields).toHaveBeenCalledTimes(poisoned.length);
    poisoned.forEach(({ name, header, sentinel }, index) => {
      const fields = withFields.mock.calls[index]?.[0] as Record<string, unknown>;
      expect(fields, name).not.toHaveProperty('upstreamVercelRequestId');
      expect(fields, name).toEqual({
        logTag: 'runtime_proxy_request_failed',
        upstreamAttempted: true,
        upstreamStatus: 401,
        sessionId: 'agent_proxy',
        kiloSessionId: 'kilo_proxy',
      });
      const serialized = JSON.stringify(fields);
      expect(serialized, name).not.toContain(header);
      expect(serialized, name).not.toContain(sentinel);
    });
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANONYMOUS_DISTINCT_ID,
  buildCapturePayload,
  callRejectedEvent,
  classifyToolError,
  createMcpAnalytics,
  oauthSignInEvent,
  queryShape,
  searchPerformedEvent,
  sessionStartedEvent,
  toolCalledEvent,
} from './analytics';
import type {
  AnalyticsIdentity,
  CapturePayload,
  McpAnalytics,
  McpAnalyticsEvent,
  SearchPerformedInput,
} from './analytics';
import { JsonRpcFailure } from './types';

const identity: AnalyticsIdentity = { kiloUserId: 'user-123', organizationId: 'org-123' };
const personalIdentity: AnalyticsIdentity = { kiloUserId: 'user-456', organizationId: null };

const API_KEY = 'phc_test_key';
const POSTHOG_URL = 'https://us.i.posthog.com/i/v0/e/';

/** The full capture property set is compared, never a subset. */
function expectExactKeys(payload: CapturePayload, expected: string[]): void {
  expect(Object.keys(payload.properties).sort()).toEqual([...expected].sort());
}

const BASE_AUTH = ['feature', '$lib', 'userId', 'organizationId'];
const BASE_ANON = ['feature', '$lib', '$process_person_profile'];

describe('event builders: property allowlists', () => {
  it('sessionStartedEvent emits only protocolVersion, clientName, and the shared context', () => {
    const payload = buildCapturePayload(
      sessionStartedEvent({ identity, protocolVersion: '2025-06-18', clientName: 'kilo-cli' }),
      API_KEY
    );
    expect(payload.event).toBe('kilo_mcp_session_started');
    expectExactKeys(payload, [...BASE_AUTH, 'protocolVersion', 'clientName']);
  });

  it('sessionStartedEvent omits absent optional properties', () => {
    const payload = buildCapturePayload(sessionStartedEvent({ identity }), API_KEY);
    expectExactKeys(payload, BASE_AUTH);
  });

  it('toolCalledEvent emits tool, success, errorClass, latencyMs, and path when present', () => {
    const payload = buildCapturePayload(
      toolCalledEvent({
        identity,
        tool: 'call',
        path: 'organizations.list',
        success: true,
        errorClass: 'none',
        latencyMs: 12,
      }),
      API_KEY
    );
    expect(payload.event).toBe('kilo_mcp_tool_called');
    expectExactKeys(payload, [...BASE_AUTH, 'tool', 'success', 'errorClass', 'latencyMs', 'path']);
  });

  it('toolCalledEvent omits path when absent', () => {
    const payload = buildCapturePayload(
      toolCalledEvent({
        identity,
        tool: 'search',
        success: false,
        errorClass: 'invalid_params',
        latencyMs: 3,
      }),
      API_KEY
    );
    expectExactKeys(payload, [...BASE_AUTH, 'tool', 'success', 'errorClass', 'latencyMs']);
  });

  it('searchPerformedEvent emits only the query shape and hit metadata', () => {
    const payload = buildCapturePayload(
      searchPerformedEvent({
        identity,
        hitCount: 3,
        empty: false,
        queryTokenCount: 2,
        queryCharBucket: '17-64',
        limit: 10,
      }),
      API_KEY
    );
    expect(payload.event).toBe('kilo_mcp_search_performed');
    expectExactKeys(payload, [
      ...BASE_AUTH,
      'hitCount',
      'empty',
      'queryTokenCount',
      'queryCharBucket',
      'limit',
    ]);
  });

  it('callRejectedEvent emits reason and path when present', () => {
    const payload = buildCapturePayload(
      callRejectedEvent({ identity, reason: 'unknown_path', path: 'nope.missing' }),
      API_KEY
    );
    expect(payload.event).toBe('kilo_mcp_call_rejected');
    expectExactKeys(payload, [...BASE_AUTH, 'reason', 'path']);
  });

  it('callRejectedEvent omits path when absent', () => {
    const payload = buildCapturePayload(
      callRejectedEvent({ identity, reason: 'auth_failure' }),
      API_KEY
    );
    expectExactKeys(payload, [...BASE_AUTH, 'reason']);
  });

  it('oauthSignInEvent selects the event by phase and emits clientId/reason when present', () => {
    const started = buildCapturePayload(
      oauthSignInEvent({ identity, phase: 'started', clientId: 'client-1' }),
      API_KEY
    );
    expect(started.event).toBe('kilo_mcp_oauth_sign_in_started');
    expectExactKeys(started, [...BASE_AUTH, 'phase', 'clientId']);

    const succeeded = buildCapturePayload(
      oauthSignInEvent({ identity, phase: 'succeeded' }),
      API_KEY
    );
    expect(succeeded.event).toBe('kilo_mcp_oauth_sign_in_succeeded');
    expectExactKeys(succeeded, [...BASE_AUTH, 'phase']);

    const failed = buildCapturePayload(
      oauthSignInEvent({ identity, phase: 'failed', reason: 'access_denied' }),
      API_KEY
    );
    expect(failed.event).toBe('kilo_mcp_oauth_sign_in_failed');
    expectExactKeys(failed, [...BASE_AUTH, 'phase', 'reason']);
  });
});

describe('identity binding', () => {
  it('binds authenticated events to the user and the organization', () => {
    const payload = buildCapturePayload(
      callRejectedEvent({ identity, reason: 'schema_invalid' }),
      API_KEY
    );
    expect(payload.distinct_id).toBe(identity.kiloUserId);
    expect(payload.properties['userId']).toBe(identity.kiloUserId);
    expect(payload.properties['organizationId']).toBe(identity.organizationId);
  });

  it('omits organizationId when the identity has no organization', () => {
    const payload = buildCapturePayload(
      sessionStartedEvent({ identity: personalIdentity }),
      API_KEY
    );
    expect(payload.distinct_id).toBe('user-456');
    expect(payload.properties).toHaveProperty('userId', 'user-456');
    expect(payload.properties).not.toHaveProperty('organizationId');
  });

  it('null identity uses the anonymous id, creates no person, and has no userId', () => {
    const payload = buildCapturePayload(
      searchPerformedEvent({
        identity: null,
        hitCount: 0,
        empty: true,
        queryTokenCount: 1,
        queryCharBucket: '1-16',
        limit: 10,
      }),
      API_KEY
    );
    expect(payload.distinct_id).toBe(ANONYMOUS_DISTINCT_ID);
    expect(payload.distinct_id).toBe('kilo-mcp-anonymous');
    expect(payload.properties['$process_person_profile']).toBe(false);
    expect(payload.properties).not.toHaveProperty('userId');
    expect(payload.properties).not.toHaveProperty('organizationId');
    expectExactKeys(payload, [
      ...BASE_ANON,
      'hitCount',
      'empty',
      'queryTokenCount',
      'queryCharBucket',
      'limit',
    ]);
  });
});

describe('secret absence', () => {
  const SENTINEL_QUERY = 'SENTINEL-QUERY-9f';
  const SENTINEL_AUTH = 'Bearer SENTINEL-AUTH-9f';
  const SENTINEL_TOKEN = 'kilo_SENTINEL-TOKEN-9f';
  // The pattern the task requires for credential-looking keys.
  const SENSITIVE_KEY_PATTERN =
    /token|authorization|cookie|secret|password|prompt|content|^query$/i;
  // `queryTokenCount` is a reviewed, required event property. The substring
  // "token" in its name is not a credential, so the documented query-shape key
  // is the one exemption from the pattern.
  const REVIEWED_SHAPE_KEYS = new Set(['queryTokenCount']);

  it('never leaks raw query text, authorization strings, or tokens', () => {
    const shape = queryShape(`${SENTINEL_QUERY} ${SENTINEL_AUTH} ${SENTINEL_TOKEN}`);
    // Extra fields a caller might wrongly forward: the builders construct an
    // explicit allowlist, so unknown keys are dropped.
    const leak = { query: SENTINEL_QUERY, authorization: SENTINEL_AUTH, token: SENTINEL_TOKEN };

    const events: McpAnalyticsEvent[] = [
      sessionStartedEvent({ identity, protocolVersion: '2025-06-18', clientName: 'kilo-cli' }),
      toolCalledEvent({
        identity,
        tool: 'search',
        success: true,
        errorClass: 'none',
        latencyMs: 4,
      }),
      searchPerformedEvent({
        identity,
        ...shape,
        hitCount: 1,
        empty: false,
        limit: 10,
        ...leak,
      } as SearchPerformedInput),
      callRejectedEvent({ identity, reason: 'auth_failure' }),
      oauthSignInEvent({ identity, phase: 'succeeded', clientId: 'client-1' }),
    ];

    for (const event of events) {
      const payload = buildCapturePayload(event, API_KEY);
      const json = JSON.stringify(payload);
      expect(json).not.toContain(SENTINEL_QUERY);
      expect(json).not.toContain(SENTINEL_AUTH);
      expect(json).not.toContain(SENTINEL_TOKEN);
      expect(payload.distinct_id).toBe(identity.kiloUserId);
      for (const [key, value] of Object.entries(payload.properties)) {
        if (!REVIEWED_SHAPE_KEYS.has(key)) {
          expect(key).not.toMatch(SENSITIVE_KEY_PATTERN);
        }
        if (typeof value === 'string') {
          expect(value).not.toContain('@');
        }
      }
    }
  });

  it('queryShape never returns the raw text', () => {
    const shape = queryShape(`Hello world ${SENTINEL_QUERY}`);
    const json = JSON.stringify(shape);
    expect(json).not.toContain('Hello');
    expect(json).not.toContain('world');
    expect(json).not.toContain(SENTINEL_QUERY);
  });
});

describe('queryShape', () => {
  it('returns a token count and a bucket for prose', () => {
    const shape = queryShape('Hello world secrets');
    expect(shape.queryTokenCount).toBe(3);
    expect(shape.queryCharBucket).toBe('17-64');
  });

  it('buckets by character length at the documented boundaries', () => {
    expect(queryShape('').queryCharBucket).toBe('0');
    expect(queryShape('a'.repeat(16)).queryCharBucket).toBe('1-16');
    expect(queryShape('a'.repeat(17)).queryCharBucket).toBe('17-64');
    expect(queryShape('a'.repeat(64)).queryCharBucket).toBe('17-64');
    expect(queryShape('a'.repeat(65)).queryCharBucket).toBe('65-256');
    expect(queryShape('a'.repeat(256)).queryCharBucket).toBe('65-256');
    expect(queryShape('a'.repeat(257)).queryCharBucket).toBe('257+');
  });
});

describe('classifyToolError', () => {
  it('classifies an unknown catalog path', () => {
    expect(
      classifyToolError(
        new JsonRpcFailure(-32602, 'Unknown path "nope.missing". The call tool only accepts ...', {
          path: 'nope.missing',
        })
      )
    ).toBe('unknown_path');
  });

  it('classifies a published-schema violation', () => {
    expect(
      classifyToolError(
        new JsonRpcFailure(
          -32602,
          'Input does not match the published schema for "x": (root): input is required',
          { path: 'x', violations: ['(root): input is required'] }
        )
      )
    ).toBe('schema_invalid');
  });

  it('classifies an unknown tool', () => {
    expect(
      classifyToolError(
        new JsonRpcFailure(-32602, 'Unknown tool "nope". Available tools: search, call.')
      )
    ).toBe('unknown_tool');
  });

  it('classifies a retryable upstream failure', () => {
    expect(
      classifyToolError(
        new JsonRpcFailure(-32000, 'Could not reach the Kilo API for "x". Retry the call.', {
          path: 'x',
          retryable: true,
        })
      )
    ).toBe('upstream_unreachable');
  });

  it('classifies a tRPC upstream failure', () => {
    expect(
      classifyToolError(
        new JsonRpcFailure(-32000, 'Upstream Kilo request failed', {
          path: 'x',
          trpcCode: 'NOT_FOUND',
        })
      )
    ).toBe('upstream_error');
  });

  it('classifies invalid params', () => {
    expect(
      classifyToolError(new JsonRpcFailure(-32602, 'search requires a non-empty string "query".'))
    ).toBe('invalid_params');
  });

  it('classifies an internal error', () => {
    expect(
      classifyToolError(
        new JsonRpcFailure(-32000, 'The Kilo API replied to "x" without a tRPC result body.', {
          path: 'x',
        })
      )
    ).toBe('internal_error');
  });

  it('classifies a plain Error by its name', () => {
    expect(classifyToolError(new Error('boom'))).toBe('Error');
  });

  it('classifies a non-error value as unknown', () => {
    expect(classifyToolError('boom')).toBe('unknown');
  });
});

type Ctx = { waitUntil(promise: Promise<unknown>): void };

function makeCtx(): { ctx: Ctx; promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: promise => {
        promises.push(promise);
      },
    },
    promises,
  };
}

const EMITS: Array<[string, (analytics: McpAnalytics) => void]> = [
  [
    'sessionStarted',
    analytics =>
      analytics.sessionStarted({ identity, protocolVersion: '2025-06-18', clientName: 'kilo-cli' }),
  ],
  [
    'toolCalled',
    analytics =>
      analytics.toolCalled({
        identity,
        tool: 'call',
        path: 'organizations.list',
        success: false,
        errorClass: 'upstream_error',
        latencyMs: 12,
      }),
  ],
  [
    'searchPerformed',
    analytics =>
      analytics.searchPerformed({
        identity,
        ...queryShape('hello world'),
        hitCount: 0,
        empty: true,
        limit: 10,
      }),
  ],
  [
    'callRejected',
    analytics =>
      analytics.callRejected({ identity, reason: 'schema_invalid', path: 'organizations.list' }),
  ],
  [
    'oauthSignIn',
    analytics =>
      analytics.oauthSignIn({ identity, phase: 'failed', clientId: 'client-1', reason: 'denied' }),
  ],
];

describe('createMcpAnalytics failure paths never throw', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  it('(a) survives a synchronous fetch throw, waitUntil gets a resolving promise', async () => {
    const { ctx, promises } = makeCtx();
    const throwingFetch = (() => {
      throw new Error('sync boom');
    }) as unknown as typeof fetch;
    const analytics = createMcpAnalytics({
      env: { NEXT_PUBLIC_POSTHOG_KEY: API_KEY },
      ctx,
      fetchImpl: throwingFetch,
      log: () => {},
    });

    for (const [, emit] of EMITS) {
      expect(() => emit(analytics)).not.toThrow();
    }
    expect(promises).toHaveLength(EMITS.length);
    await Promise.all(promises);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('(b) survives a rejected fetch, waitUntil gets a resolving promise', async () => {
    const { ctx, promises } = makeCtx();
    const rejectingFetch = vi.fn().mockRejectedValue(new Error('rejected'));
    const analytics = createMcpAnalytics({
      env: { NEXT_PUBLIC_POSTHOG_KEY: API_KEY },
      ctx,
      fetchImpl: rejectingFetch as unknown as typeof fetch,
      log: () => {},
    });

    for (const [, emit] of EMITS) {
      expect(() => emit(analytics)).not.toThrow();
    }
    expect(promises).toHaveLength(EMITS.length);
    await Promise.all(promises);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('(c) survives a never-resolving fetch, waitUntil is still called', async () => {
    const { ctx, promises } = makeCtx();
    const pendingFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const analytics = createMcpAnalytics({
      env: { NEXT_PUBLIC_POSTHOG_KEY: API_KEY },
      ctx,
      fetchImpl: pendingFetch,
      log: () => {},
    });

    for (const [, emit] of EMITS) {
      expect(() => emit(analytics)).not.toThrow();
    }
    expect(promises).toHaveLength(EMITS.length);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('(d) survives failure when there is no ExecutionContext', () => {
    const throwingFetch = (() => {
      throw new Error('sync boom');
    }) as unknown as typeof fetch;
    const analytics = createMcpAnalytics({
      env: { NEXT_PUBLIC_POSTHOG_KEY: API_KEY },
      fetchImpl: throwingFetch,
      log: () => {},
    });

    for (const [, emit] of EMITS) {
      expect(() => emit(analytics)).not.toThrow();
    }
  });
});

describe('createMcpAnalytics transport and gating', () => {
  it('logs the decisive line but does not fetch when the key is unset or empty', () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const log = vi.fn();
    for (const key of [undefined, '']) {
      const analytics = createMcpAnalytics({
        env: { NEXT_PUBLIC_POSTHOG_KEY: key },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log,
      });
      analytics.toolCalled({
        identity,
        tool: 'search',
        success: true,
        errorClass: 'none',
        latencyMs: 1,
      });
    }

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toMatch(/^\[kilo-mcp\] analytics kilo_mcp_tool_called /);
  });

  it('logs event and properties without the key', () => {
    const log = vi.fn();
    const { ctx } = makeCtx();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const analytics = createMcpAnalytics({
      env: { NEXT_PUBLIC_POSTHOG_KEY: API_KEY },
      ctx,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
    });

    analytics.callRejected({ identity, reason: 'unknown_path', path: 'nope.missing' });

    const line = String(log.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('kilo_mcp_call_rejected');
    expect(line).toContain('unknown_path');
    expect(line).toContain('userId');
    expect(line).not.toContain(API_KEY);
  });

  it('posts the capture payload with a timeout and consumes the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { ctx, promises } = makeCtx();
    const analytics = createMcpAnalytics({
      env: { NEXT_PUBLIC_POSTHOG_KEY: API_KEY },
      ctx,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });

    analytics.searchPerformed({
      identity,
      ...queryShape('hello world'),
      hitCount: 2,
      empty: false,
      limit: 10,
    });
    await Promise.all(promises);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(POSTHOG_URL);
    expect(init).toMatchObject({ method: 'POST' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body['api_key']).toBe(API_KEY);
    expect(body['event']).toBe('kilo_mcp_search_performed');
    expect(body['distinct_id']).toBe(identity.kiloUserId);
    const properties = body['properties'] as Record<string, unknown>;
    expect(properties['feature']).toBe('kilo-mcp');
    expect(properties['$lib']).toBe('kilo-mcp-worker');
    expect(properties['userId']).toBe(identity.kiloUserId);
    expect(properties['organizationId']).toBe(identity.organizationId);
  });
});

import { beforeEach, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import {
  access,
  authority,
  call,
  capability,
  conversationId,
  operationId,
  originalTime,
  primary,
  runId,
  runtime,
  toolCallId,
} from './operation-test-fixture';
import type * as Route from '@/app/api/internal/agent-harness/operations/route';
import type * as CloudContext from './cloud-agent-context';

let output: unknown, failure: Error | undefined;
let onWebDispatch: ((signal: AbortSignal) => void) | undefined;
const effects = new Map<string, unknown>();
const cloudInputs: unknown[] = [];
jest.mock('@/routers/root-router', () => ({ rootRouter: { createCaller: () => ({}) } }));
jest.mock('./kilo-reads', () => ({
  executeHarnessRead: async () => {
    if (failure) throw failure;
    return output;
  },
}));
jest.mock('./invitation', () => ({
  executeHarnessInvitation: async () => {
    effects.set('invitation', Number(effects.get('invitation') ?? 0) + 1);
    if (failure) throw failure;
    return { invitationId: toolCallId, emailQueued: true };
  },
  reconcileHarnessInvitation: async () =>
    effects.has('invitation') ? { invitationId: toolCallId, emailQueued: true } : null,
}));
jest.mock('./cloud-agent', () => ({
  executeHarnessCloudAgent: (token: string, input: unknown) => cloud(token, input),
  reconcileHarnessCloudAgent: (token: string, input: unknown) => cloud(token, input),
}));
jest.mock('./mcp', () => ({
  authorizeHarnessMcp: async () => {
    if (failure) throw failure;
    return output;
  },
}));
jest.mock('./web-tools', () => ({
  executeHarnessWeb: async (
    _token: string,
    _input: unknown,
    _limit: number,
    signal: AbortSignal
  ) => {
    effects.set('web', true);
    onWebDispatch?.(signal);
    return output;
  },
}));
async function cloud(token: string, input: unknown) {
  cloudInputs.push(input);
  const context = jest
    .requireActual<typeof CloudContext>('./cloud-agent-context')
    .createHarnessCloudAgentContext(token, input);
  await context.fresh();
  return context.succeeded({ sessionId: 'ses_12345678901234567890123456' });
}
const { POST } = jest.requireActual<typeof Route>(
  '@/app/api/internal/agent-harness/operations/route'
);
const invokeResponse = (
  input: unknown,
  token = capability(input),
  service = 'test-service-key',
  init: RequestInit = {}
) => {
  const headers = new Headers({
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-internal-api-key': service,
  });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return POST(
    new Request('https://app.example/api/internal/agent-harness/operations', {
      method: 'POST',
      body: JSON.stringify(input),
      ...init,
      headers,
    })
  );
};
const invoke = async (...args: Parameters<typeof invokeResponse>) => {
  const response = await invokeResponse(...args);
  return {
    status: response.status,
    body: (await response.json()) as any,
    cache: response.headers.get('cache-control'),
  };
};
const identity = { conversationId, operationId };
const reservation = {
  id: operationId,
  runId,
  toolCallId,
  startedAt: originalTime,
  deadline: originalTime + 30000,
  kind: 'tool',
  status: 'reserved',
  webRequest: true,
};
const web = { ...call('web.search', { query: 'Kilo' }), reservation };
beforeEach(() => {
  output = [];
  failure = onWebDispatch = undefined;
  effects.clear();
  cloudInputs.length = 0;
});

it.each([
  'service',
  'wrong service',
  'bearer',
  'signature',
  'expired capability',
  'expired grant',
  'role',
  'retirement',
])('blocks %s without an effect', async reason => {
  const input = call('kilo.invite', { recipient: 'member@example.com', role: 'member' });
  const token = capability(input);
  if (reason === 'expired capability') jest.mocked(Date.now).mockReturnValue(originalTime + 60000);
  if (reason === 'expired grant') access.expires = new Date(originalTime).toISOString();
  if (reason === 'role') access.role = false;
  if (reason === 'retirement') access.active = false;
  const result = await invoke(
    input,
    reason === 'signature' ? 'forged' : reason === 'bearer' ? '' : token,
    reason === 'service'
      ? ''
      : reason === 'wrong service'
        ? 'wrong-service-key'
        : 'test-service-key'
  );
  expect(result.body).toMatchObject({ error: { code: 'access_revoked', retryable: false } });
  expect(result.status).toBe(['service', 'wrong service', 'bearer'].includes(reason) ? 401 : 403);
  expect(result.cache).toBe('no-store');
  expect(effects.size).toBe(0);
  expect(JSON.stringify(result)).not.toContain('secret-role-details');
});
it.each([
  { type: 'arbitrary.trpc' },
  { userId: 'forged' },
  { request: { name: 'app.openScreen', arguments: { screen: 'preferences' } } },
  {
    request: {
      name: 'kilo.invite',
      arguments: { recipient: 'another@example.com', role: 'owner' },
    },
  },
  { type: 'reconcile' },
  { dispatchStartedAt: originalTime + 1 },
])('rejects forged routing or input %j', async patch => {
  const input = call('kilo.invite', { recipient: 'member@example.com', role: 'member' });
  expect((await invoke({ ...input, ...patch }, capability(input))).status).not.toBe(200);
  expect(effects.size).toBe(0);
});
it.each([
  call('mcp.discover'),
  call('mcp.call', {
    serverId: 'server',
    configurationVersion: '1',
    name: 'remote',
    definitionVersion: '1',
    arguments: {},
  }),
])('keeps derived $request.name connections uncached and redacted', async input => {
  const connection = {
    serverId: 'server',
    configurationVersion: '1',
    url: 'https://gateway.example/server',
    authorization: 'Bearer derived',
  };
  output = [{ ...connection, providerSecret: 'provider-secret' }];
  expect(await invoke(input)).toEqual({
    status: 200,
    body: { result: [connection] },
    cache: 'no-store',
  });
});
it('rejects oversized UTF-8 request bytes before JSON parsing and never returns the body', async () => {
  const result = await invoke(call(), capability(call()), 'test-service-key', {
    body: '界'.repeat(22000),
  });
  expect(result.status).toBe(400);
  expect(result.body.error.code).toBe('limit_exceeded');
  expect(result.cache).toBe('no-store');
  expect(JSON.stringify(result)).not.toContain('界');
  expect(effects.size).toBe(0);
});
it.each<RequestInit>([
  { body: '{private-body' },
  { body: null },
  { headers: { 'content-type': 'text/plain' } },
])('rejects malformed JSON, missing bodies, and unsupported media (case %#)', async init => {
  const result = await invoke(call(), capability(call()), 'test-service-key', init);
  expect(result).toMatchObject({
    status: 400,
    body: { error: { code: 'invalid_input', retryable: false } },
    cache: 'no-store',
  });
  expect(effects.size).toBe(0);
  expect(JSON.stringify(result)).not.toContain('private-body');
});
it('rejects invalid UTF-8 rather than executing replacement text', async () => {
  const input = call('kilo.sessions.start', { prompt: '�', modelId: 'model' });
  const body = Buffer.from(JSON.stringify(input).replace('�', '\xff'), 'latin1');
  expect(
    (await invoke(input, capability(input), 'test-service-key', { body })).body.error.code
  ).toBe('invalid_input');
  expect(cloudInputs).toEqual([]);
});
it.each(['kilo.organizations', 'mcp.discover'])('returns honest empty %s results', async name => {
  expect((await invoke(call(name))).body).toEqual({
    result: name === 'mcp.discover' ? [] : { status: 'succeeded', output: [] },
  });
});
it.each([
  ['SERVICE_UNAVAILABLE', 'provider-secret', 'unavailable_tool', true, 503],
  ['PRECONDITION_FAILED', 'reauthorization_required', 'reauthorization_required', false, 400],
] as const)(
  'preserves sanitized %s recovery',
  async (code, message, expected, retryable, status) => {
    failure = new TRPCError({ code, message, cause: new Error('provider-secret') });
    const result = await invoke(call('mcp.discover'));
    expect(result).toMatchObject({
      status,
      body: { error: { code: expected, retryable } },
      cache: 'no-store',
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    failure = undefined;
    expect((await invoke(call('mcp.discover'))).body).toEqual({ result: [] });
  }
);
it.each([null, [{ id: 'resource', name: '界'.repeat(22000) }]])(
  'rejects invalid or oversized read output (case %#)',
  async value => {
    output = value;
    expect((await invoke(call())).body.error.code).toBe(
      value === null ? 'invalid_output' : 'limit_exceeded'
    );
  }
);
it('preserves dispatch time, its digest, and explicit legacy reconciliation absence', async () => {
  const input = call('kilo.sessions.start', { prompt: 'Fix', modelId: 'model' });
  expect((await invoke(input)).body.result.status).toBe('succeeded');
  jest.mocked(Date.now).mockReturnValue(originalTime + 120000);
  expect((await invoke({ ...input, type: 'reconcile' })).body.result.status).toBe('succeeded');
  const invocation = { ...identity, ...input.request, dispatchStartedAt: originalTime };
  expect(cloudInputs).toStrictEqual([invocation, invocation]);
  expect((await invoke({ ...input, dispatchStartedAt: undefined })).body.error.code).toBe(
    'invalid_input'
  );
  const legacy = { ...input, type: 'reconcile', dispatchStartedAt: undefined };
  expect((await invoke(legacy)).body.error).toMatchObject({
    code: 'outcome_unknown',
    retryable: false,
  });
  expect(cloudInputs[2]).toStrictEqual({ ...invocation, dispatchStartedAt: undefined });
});
it('reconciles a lost invitation result without another effect', async () => {
  const input = call('kilo.invite', { recipient: 'member@example.com', role: 'member' });
  failure = new Error('provider-secret');
  expect((await invoke(input)).body.error).toMatchObject({
    code: 'outcome_unknown',
    retryable: false,
  });
  expect((await invoke({ ...input, type: 'reconcile' })).body.result).toEqual({
    status: 'succeeded',
    output: { invitationId: toolCallId, emailQueued: true },
  });
  expect(effects.get('invitation')).toBe(1);
});
it.each([
  call('web.search', { query: 'Kilo' }),
  call('web.retrieve', { url: 'https://example.com' }),
])('passes the signed reservation for $request.name and preserves unknown cost', async input => {
  output = { status: 'succeeded', body: { results: [] }, costMicrodollars: null };
  expect(await invoke({ ...input, reservation })).toEqual({
    status: 200,
    body: { result: output },
    cache: 'no-store',
  });
  expect(effects.get('web')).toBe(true);
});
it.each([
  undefined,
  { ...reservation, id: runId },
  { ...reservation, runId: toolCallId },
  { ...reservation, toolCallId: runId },
])('rejects a signed absent or foreign reservation (case %#)', async value => {
  expect((await invoke({ ...web, reservation: value })).body.error.code).toBe('invalid_input');
  expect(effects.size).toBe(0);
});
it('rejects reservation signature tampering before provider dispatch', async () => {
  expect(
    (await invoke({ ...web, reservation: { ...reservation, toolCallId: runId } }, capability(web)))
      .body.error.code
  ).toBe('access_revoked');
  expect(effects.size).toBe(0);
});
it.each([call('kilo.invite', { recipient: 'member@example.com', role: 'member' }), web])(
  'forwards cancellation before $request.name dispatch',
  async input => {
    const signal = AbortSignal.abort(new Error('private-abort-reason'));
    const result = await invoke(input, capability(input), 'test-service-key', { signal });
    expect(result.body).toMatchObject(
      input.request.name === 'web.search'
        ? { error: { code: 'cancelled', retryable: false } }
        : { result: { status: 'cancelled' } }
    );
    expect(effects.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private-abort-reason');
  }
);
it('propagates HTTP cancellation to an active web request', async () => {
  const controller = new AbortController();
  onWebDispatch = signal => {
    controller.abort(new Error('private-abort-reason'));
    signal.throwIfAborted();
  };
  expect(
    (await invoke(web, capability(web), 'test-service-key', { signal: controller.signal })).body
      .error
  ).toMatchObject({ code: 'cancelled', retryable: false });
});
it.each([
  call('kilo.invite', { recipient: 'member@example.com', role: 'member' }),
  call('kilo.sessions.start', { prompt: 'Fix', modelId: 'model' }),
  call('mcp.discover'),
  web,
])('rechecks primary authority before $request.name dispatch', async input => {
  jest.spyOn(runtime, 'lookupThread').mockResolvedValueOnce(authority).mockResolvedValue(null);
  expect(await invoke(input)).toMatchObject({
    status: 403,
    body: { error: { code: 'access_revoked', retryable: false } },
    cache: 'no-store',
  });
  expect(effects.size).toBe(0);
  expect(cloudInputs).toEqual([]);
});
it.each([
  call('kilo.invite', { recipient: 'member@example.com', role: 'member' }),
  call('kilo.sessions.start', { prompt: 'Fix', modelId: 'model' }),
])('keeps aborted $request.name reconciliation uncertain', async input => {
  const reconcile = { ...input, type: 'reconcile' };
  const signal = AbortSignal.abort(new Error('private-abort-reason'));
  const result = await invoke(reconcile, capability(reconcile), 'test-service-key', { signal });
  expect(result).toMatchObject({
    status: 400,
    body: { error: { code: 'outcome_unknown', retryable: false } },
    cache: 'no-store',
  });
  expect(JSON.stringify(result)).not.toContain('private-abort-reason');
  expect(effects.size).toBe(0);
  expect(cloudInputs).toEqual([]);
});
it.each(
  [web, { ...call('web.retrieve', { url: 'https://example.com' }), reservation }].flatMap(input =>
    [null, 0, 2000].flatMap(costMicrodollars =>
      [false, true].map(cancelled => ({ input, costMicrodollars, cancelled }))
    )
  )
)(
  'retains $input.request.name cost $costMicrodollars on HTTP reply overflow (cancelled: $cancelled)',
  async ({ input, costMicrodollars, cancelled }) => {
    const body = { text: `provider-secret${'界'.repeat(349510)}` };
    output = { status: 'succeeded', body, costMicrodollars };
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(1024 * 1024);
    const controller = new AbortController();
    onWebDispatch = () => {
      if (cancelled) controller.abort(new Error('private-abort-reason'));
    };
    const result = await invoke(input, capability(input), 'test-service-key', {
      signal: controller.signal,
    });
    expect(result).toEqual({
      status: 200,
      body: {
        result: {
          status: 'failed',
          error: {
            code: 'limit_exceeded',
            message: 'The operation exceeds its limit.',
            retryable: false,
          },
          costMicrodollars,
        },
      },
      cache: 'no-store',
    });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(1024);
  }
);
it.each(
  [web, { ...call('web.retrieve', { url: 'https://example.com' }), reservation }].flatMap(input =>
    [null, 0, 2000].flatMap(costMicrodollars =>
      [false, true].flatMap(cancelled =>
        [0, 1].map(extraBytes => ({ input, costMicrodollars, cancelled, extraBytes }))
      )
    )
  )
)(
  'bounds $input.request.name HTTP bytes at 1 MiB + $extraBytes with cost $costMicrodollars (cancelled: $cancelled)',
  async ({ input, costMicrodollars, cancelled, extraBytes }) => {
    const limit = 1024 * 1024;
    const body = { text: 'provider-secret界' };
    const reply = { status: 'succeeded', body, costMicrodollars };
    const padding =
      limit + extraBytes - Buffer.byteLength(JSON.stringify({ result: reply }), 'utf8');
    body.text += '界'.repeat(Math.floor(padding / 3)) + 'x'.repeat(padding % 3);
    output = reply;
    expect(Buffer.byteLength(JSON.stringify(reply), 'utf8')).toBeLessThanOrEqual(limit);
    expect(Buffer.byteLength(JSON.stringify({ result: reply }), 'utf8')).toBe(limit + extraBytes);
    const controller = new AbortController();
    onWebDispatch = () => {
      if (cancelled) controller.abort(new Error('private-abort-reason'));
    };
    const response = await invokeResponse(input, capability(input), 'test-service-key', {
      signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(bytes.byteLength).toBeLessThanOrEqual(limit);
    if (extraBytes === 0) {
      expect(bytes.byteLength).toBe(limit);
      expect(JSON.parse(bytes.toString('utf8'))).toEqual({ result: reply });
    } else {
      expect(bytes.byteLength).toBeLessThan(1024);
      expect(JSON.parse(bytes.toString('utf8'))).toEqual({
        result: {
          status: 'failed',
          error: {
            code: 'limit_exceeded',
            message: 'The operation exceeds its limit.',
            retryable: false,
          },
          costMicrodollars,
        },
      });
    }
  }
);
it('routes authority, empty history, and a projection through current primary access', async () => {
  const projection = {
    id: toolCallId,
    key: `agent-harness:${conversationId}:${toolCallId}`,
    role: 'assistant',
    content: 'Actual text',
    createdAt: new Date(originalTime).toISOString(),
  };
  Object.assign(runtime, {
    claimPending: async () => [],
    hasPending: async () => false,
    projectText: async (owner: unknown, value: { id: string; content: string }) => {
      effects.set(value.id, { owner, content: value.content });
      return value.id;
    },
  });
  const inputs = [
    { ...identity, type: 'read', purpose: 'read' },
    { ...identity, type: 'history' },
    { ...identity, type: 'projection', projection },
  ];
  expect((await invoke(inputs[0])).body).toEqual({ result: authority });
  expect((await invoke(inputs[1])).body).toEqual({
    result: { deliveries: [], backlog: 'drained' },
  });
  expect((await invoke(inputs[2])).body).toEqual({ result: toolCallId });
  expect(effects.get(toolCallId)).toEqual({ owner: authority, content: 'Actual text' });
  access.role = false;
  effects.clear();
  for (const input of inputs) expect((await invoke(input)).body.error.code).toBe('access_revoked');
  expect(effects.size).toBe(0);
});
it('routes only the exact fenced retirement without requiring a live grant', async () => {
  const input = { ...identity, type: 'retirement', generation: 0 };
  const request = { type: 'purge', protocolVersion: 1, threadId: conversationId, generation: 0 };
  const token = jwt.sign(
    {
      operation: 'purge',
      threadId: conversationId,
      generation: 0,
      dispatchId: operationId,
      inputDigest: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    },
    'test-signing-key',
    { issuer: 'agent-harness', audience: 'agent-harness:maintenance', expiresIn: 60 }
  );
  let fence: { thread_id: string; generation: number } | undefined = {
    thread_id: conversationId,
    generation: 0,
  };
  Object.assign(primary.query, { agent_harness_retirements: { findFirst: async () => fence } });
  access.active = false;
  expect((await invoke(input, token)).body).toEqual({ result: { retired: true } });
  expect((await invoke({ ...input, generation: 1 }, token)).status).toBe(403);
  expect((await invoke(input, capability(input))).status).toBe(403);
  fence = undefined;
  expect((await invoke(input, token)).status).toBe(403);
});

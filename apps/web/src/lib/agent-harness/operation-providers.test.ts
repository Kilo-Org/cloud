import { beforeEach, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';
import {
  access,
  authority,
  call,
  capability,
  operationId,
  originalTime,
  runId,
  runtime,
  toolCallId,
} from './operation-test-fixture';
import type * as Authorization from './authorization';
import type * as Providers from './operation-providers';

type Invocation = Pick<ReturnType<typeof call>, 'conversationId' | 'operationId' | 'request'>;
let output: unknown, failure: Error | undefined;
let onWebDispatch: ((signal: AbortSignal) => Promise<void>) | undefined;
const effects: string[] = [];
jest.mock('./mcp', () => ({
  authorizeHarnessMcp: (token: string, input: Invocation) => provider(token, input),
}));
jest.mock('./web-tools', () => ({
  executeHarnessWeb: async (
    token: string,
    input: Invocation,
    limit: number,
    signal: AbortSignal
  ) => {
    if (limit !== 1024 * 1024) throw new Error('Wrong transport bound');
    const result = await provider(token, input);
    await onWebDispatch?.(signal);
    return result;
  },
}));
const { authorizeHarnessCapability, harnessInputDigest } =
  jest.requireActual<typeof Authorization>('./authorization');
const { executeHarnessProviders } = jest.requireActual<typeof Providers>('./operation-providers');
async function provider(token: string, input: Invocation) {
  await authorizeHarnessCapability(token, {
    audience: 'agent-harness:operations',
    conversationId: input.conversationId,
    operation: input.request.name,
    definitionVersion: '1',
    inputDigest: harnessInputDigest(input.request.arguments),
    dispatchId: input.operationId,
    target: { kind: 'backend' },
  });
  effects.push(input.request.name);
  if (failure) throw failure;
  return output;
}
const invoke = (raw: unknown, token = capability(raw), signal = new AbortController().signal) =>
  executeHarnessProviders(JSON.parse(JSON.stringify(raw)), token, signal);
const connection = {
  serverId: 'server',
  configurationVersion: '1',
  url: 'https://gateway.example/server',
  authorization: 'Bearer derived',
};
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
const web = { ...call('web.search', { query: 'Kilo', limit: 5 }), reservation };
const requests = [
  call('mcp.discover'),
  call('mcp.call', {
    serverId: 'server',
    configurationVersion: '1',
    name: 'remote',
    definitionVersion: 'remote-v1',
    arguments: { text: 'Actual input' },
  }),
  web,
  { ...call('web.retrieve', { url: 'https://example.com' }), reservation },
];
function signedRaw(raw: unknown) {
  // Unlike the normal fixture signer, this also signs malformed reservation state.
  const claims = jwt.decode(capability(web)) as jwt.JwtPayload;
  claims.scope.inputDigest = harnessInputDigest(JSON.parse(JSON.stringify(raw)));
  return jwt.sign(claims, 'test-signing-key');
}
beforeEach(() => {
  output = [];
  failure = onWebDispatch = undefined;
  effects.length = 0;
  Object.assign(authority, { organizationId: runId });
});

it.each(requests)(
  'authorizes $request.name with narrow capabilities and actual output',
  async input => {
    for (const organizationId of [null, runId]) {
      Object.assign(authority, { organizationId });
      const mcp = input.request.name.startsWith('mcp.');
      output = mcp
        ? [{ ...connection, providerSecret: 'provider-secret' }]
        : {
            status: 'succeeded',
            costMicrodollars: 2000,
            body: {
              results: [{ url: 'https://example.com', title: 'Actual source', text: 'Page text' }],
            },
          };
      expect(await invoke(input)).toEqual({ result: mcp ? [connection] : output });
    }
  }
);
it.each([null, 0])(
  'preserves empty results and actual nullable cost %s',
  async costMicrodollars => {
    expect(await invoke(call('mcp.discover'))).toEqual({ result: [] });
    output = { status: 'succeeded', body: { results: [] }, costMicrodollars };
    for (const input of requests.slice(2)) expect(await invoke(input)).toEqual({ result: output });
  }
);
it.each(['account', 'membership', 'expiry', 'mint', 'signature'])(
  'rejects lost %s authority without provider effects',
  async loss => {
    if (loss === 'account') access.active = false;
    if (loss === 'membership') access.role = false;
    if (loss === 'expiry') access.expires = new Date(originalTime).toISOString();
    if (loss === 'mint')
      jest.spyOn(runtime, 'lookupThread').mockResolvedValueOnce(authority).mockResolvedValue(null);
    for (const input of requests) {
      expect(
        await invoke(input, loss === 'signature' ? 'forged-token' : capability(input))
      ).toMatchObject({ error: { code: 'access_revoked', retryable: false } });
    }
    expect(effects).toEqual([]);
  }
);
const changes = [
  { id: runId },
  { runId: toolCallId },
  { toolCallId: runId },
  { startedAt: originalTime + 1 },
  { deadline: originalTime },
  { deadline: originalTime + 1 },
  { deadline: originalTime + 30001 },
];
it.each(changes)('rejects reservation signature tampering: %j', async patch => {
  for (const input of requests.slice(2)) {
    const raw = { ...input, reservation: { ...reservation, ...patch } };
    expect(await invoke(raw, capability(input))).toMatchObject({
      error: { code: 'access_revoked', retryable: false },
    });
  }
  expect(effects).toEqual([]);
});
it.each([...changes, { kind: 'model' }, { status: 'finished' }, { webRequest: false }])(
  'rejects a validly signed invalid reservation: %j',
  async patch => {
    for (const input of requests.slice(2)) {
      const raw = { ...input, reservation: { ...reservation, ...patch } };
      expect(await invoke(raw, signedRaw(raw))).toMatchObject({
        error: { code: 'invalid_input', retryable: false },
      });
    }
    expect(effects).toEqual([]);
  }
);
it.each([
  { reservation: undefined },
  { dispatchStartedAt: undefined },
  {
    dispatchStartedAt: originalTime + 2,
    reservation: { ...reservation, startedAt: originalTime + 2 },
  },
])('rejects signed absent or future dispatch identity: %j', async patch => {
  const raw = { ...web, ...patch };
  expect(await invoke(raw)).toMatchObject({ error: { code: 'invalid_input', retryable: false } });
  expect(effects).toEqual([]);
});
it('rejects a deadline that expires while minting the narrow capability', async () => {
  jest
    .spyOn(runtime, 'lookupThread')
    .mockResolvedValueOnce(authority)
    .mockImplementationOnce(async () => {
      jest.mocked(Date.now).mockReturnValue(reservation.deadline);
      return authority;
    });
  expect(await invoke(web)).toMatchObject({ error: { code: 'invalid_input', retryable: false } });
  expect(effects).toEqual([]);
});
it.each([
  call('kilo.organizations'),
  call('app.currentScreen'),
  ...requests.map(input => ({ ...input, type: 'reconcile' })),
])('rejects unsupported $type for $request.name', async input => {
  expect(await invoke(input)).toMatchObject({ error: { code: 'invalid_input', retryable: false } });
  expect(effects).toEqual([]);
});
it('rejects a changed signed MCP request before authorization reaches the provider', async () => {
  expect(await invoke(requests[1], capability(requests[0]))).toMatchObject({
    error: { code: 'access_revoked', retryable: false },
  });
  expect(effects).toEqual([]);
});
it.each([
  ['SERVICE_UNAVAILABLE', 'provider-secret', 'unavailable_tool', true],
  ['PRECONDITION_FAILED', 'reauthorization_required', 'reauthorization_required', false],
  ['BAD_REQUEST', 'provider-secret', 'invalid_input', false],
] as const)(
  'sanitizes MCP %s without changing recovery',
  async (code, message, expected, retryable) => {
    failure = new TRPCError({ code, message, cause: new Error('provider-secret') });
    const result = await invoke(call('mcp.discover'));
    expect(result).toMatchObject({ error: { code: expected, retryable } });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(effects).toEqual(['mcp.discover']);
  }
);
it.each([
  ['unavailable_tool', true],
  ['unavailable_tool', false],
  ['reauthorization_required', false],
  ['invalid_input', false],
  ['invalid_output', false],
  ['limit_exceeded', false],
] as const)('preserves sanitized web %s (retryable: %s)', async (code, retryable) => {
  output = {
    status: 'failed',
    error: { code, message: 'provider-secret', retryable },
    costMicrodollars: null,
  };
  const result = await invoke(web);
  expect(result).toMatchObject({
    result: { status: 'failed', error: { code, retryable }, costMicrodollars: null },
  });
  expect(JSON.stringify(result)).not.toContain('provider-secret');
  expect(effects).toEqual(['web.search']);
});
it('rejects malformed, credentialed, and oversized MCP connections', async () => {
  for (output of [
    null,
    [{ ...connection, serverId: '' }],
    [{ ...connection, url: 'http://gateway.example' }],
    [{ ...connection, url: 'https://user:provider-secret@gateway.example' }],
    [{ ...connection, authorization: 'Bearer ' }],
    [{ ...connection, authorization: `Bearer ${'x'.repeat(8192)}` }],
  ])
    expect(await invoke(call('mcp.discover'))).toMatchObject({ error: { code: 'invalid_output' } });
  output = [{ ...connection, configurationVersion: '界'.repeat(22000) }];
  expect(await invoke(call('mcp.discover'))).toMatchObject({ error: { code: 'limit_exceeded' } });
});
it('rejects invalid web costs and bounds serialized UTF-8 output', async () => {
  for (const costMicrodollars of [undefined, -1, 0.5, '0']) {
    output = { status: 'succeeded', body: {}, costMicrodollars };
    expect(await invoke(web)).toMatchObject({
      error: { code: 'invalid_output', retryable: false },
    });
  }
  output = { status: 'succeeded', body: { text: '界'.repeat(350000) }, costMicrodollars: 0 };
  expect(await invoke(web)).toMatchObject({
    result: {
      status: 'failed',
      error: { code: 'limit_exceeded', retryable: false },
      costMicrodollars: 0,
    },
  });
});
it.each(
  requests
    .slice(2)
    .flatMap(input =>
      [null, 0, 2000].flatMap(costMicrodollars =>
        [false, true].map(cancelled => ({ input, costMicrodollars, cancelled }))
      )
    )
)(
  'retains $input.request.name cost $costMicrodollars on reply overflow (cancelled: $cancelled)',
  async ({ input, costMicrodollars, cancelled }) => {
    const body = { text: `provider-secret${'界'.repeat(349510)}` };
    output = { status: 'succeeded', body, costMicrodollars };
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeGreaterThan(1024 * 1024);
    const controller = new AbortController();
    onWebDispatch = async () => {
      if (cancelled) controller.abort(new Error('private-abort-reason'));
    };
    const result = await invoke(input, capability(input), controller.signal);
    expect(result).toEqual({
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
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(1024);
    expect(effects).toEqual([input.request.name]);
  }
);
it.each(requests)('cancels $request.name before any provider effect', async input => {
  const controller = new AbortController();
  controller.abort(new Error('private-abort-reason'));
  const result = await invoke(input, capability(input), controller.signal);
  expect(result).toMatchObject({ error: { code: 'cancelled', retryable: false } });
  expect(JSON.stringify(result)).not.toContain('private-abort-reason');
  expect(effects).toEqual([]);
});
it.each(['caller', 'deadline'])('propagates %s cancellation to the web adapter', async source => {
  const controller = new AbortController();
  const input = { ...web, reservation: { ...reservation, deadline: originalTime + 25 } };
  onWebDispatch = async signal => {
    if (source === 'caller') controller.abort(new Error('provider-secret'));
    if (!signal.aborted)
      await new Promise<void>(resolve =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    signal.throwIfAborted();
  };
  expect(await invoke(input, capability(input), controller.signal)).toMatchObject({
    error: { code: 'cancelled', retryable: false },
  });
  expect(effects).toEqual(['web.search']);
});
it.each(requests.slice(2))(
  'retains $request.name cancellation and unknown cost from the adapter',
  async input => {
    const controller = new AbortController();
    onWebDispatch = async () => {
      controller.abort();
    };
    output = {
      status: 'failed',
      error: { code: 'cancelled', message: 'provider-secret', retryable: false },
      costMicrodollars: null,
    };
    const result = await invoke(input, capability(input), controller.signal);
    expect(result).toMatchObject({
      result: {
        status: 'failed',
        error: { code: 'cancelled', retryable: false },
        costMicrodollars: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(effects).toEqual([input.request.name]);
  }
);
it('retains an actual result and cost when cancellation races with the response', async () => {
  const controller = new AbortController();
  onWebDispatch = async () => {
    controller.abort();
  };
  output = { status: 'succeeded', body: { results: [] }, costMicrodollars: 2000 };
  expect(await invoke(web, capability(web), controller.signal)).toEqual({ result: output });
  expect(effects).toEqual(['web.search']);
});

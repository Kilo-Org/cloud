import { beforeEach, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';
import { OrganizationRoleSchema } from '@/lib/organizations/organization-types';
import {
  access,
  authority,
  call,
  capability,
  conversationId,
  operationId,
  originalTime,
  runId,
  runtime,
  toolCallId,
} from './operation-test-fixture';
import type * as Dispatch from './operation-dispatch';
import type * as CloudContext from './cloud-agent-context';
import type * as Invitation from './invitation';

const sessionId = 'ses_12345678901234567890123456';
const mutations = [
  ['start', { prompt: 'Fix', modelId: 'model' }],
  ['continue', { sessionId, message: 'Continue' }],
  ['stop', { sessionId }],
] as const;
let output: unknown, cloudOutcome: unknown, failure: Error | undefined;
const effects = new Map<string, number>();
const cloudInputs: unknown[] = [],
  contexts: unknown[] = [];
jest.mock('@/routers/root-router', () => ({
  rootRouter: {
    createCaller: (ctx: unknown) => {
      contexts.push(ctx);
      return {};
    },
  },
}));
jest.mock('./kilo-reads', () => ({
  executeHarnessRead: async () => {
    if (failure) throw failure;
    return output;
  },
}));
jest.mock('./invitation', () => ({
  executeHarnessInvitation: async (_token: string, input: { arguments: { role: string } }) => {
    OrganizationRoleSchema.parse(input.arguments.role);
    effects.set('invitation', (effects.get('invitation') ?? 0) + 1);
    if (failure) throw failure;
    return { invitationId: toolCallId, emailQueued: true };
  },
  reconcileHarnessInvitation: async (_token: string, input: { arguments: { role: string } }) => {
    OrganizationRoleSchema.parse(input.arguments.role);
    return effects.has('invitation') ? { invitationId: toolCallId, emailQueued: true } : null;
  },
}));
jest.mock('./cloud-agent', () => ({
  executeHarnessCloudAgent: (token: string, input: unknown) => cloud(token, input, false),
  reconcileHarnessCloudAgent: (token: string, input: unknown) => cloud(token, input, true),
}));
const { executeHarnessDispatch } = jest.requireActual<typeof Dispatch>('./operation-dispatch');
async function cloud(token: string, input: unknown, reconcile: boolean) {
  cloudInputs.push(input);
  const context = jest
    .requireActual<typeof CloudContext>('./cloud-agent-context')
    .createHarnessCloudAgentContext(token, input);
  await context.fresh();
  if (cloudOutcome !== undefined) return cloudOutcome;
  if (!context.messageId) return context.succeeded(output);
  if (!reconcile) {
    effects.set(context.messageId, (effects.get(context.messageId) ?? 0) + 1);
    if (failure) throw failure;
  }
  return effects.has(context.messageId) &&
    !(reconcile && context.request.name === 'kilo.sessions.stop')
    ? context.succeeded({ sessionId })
    : {
        status: 'outcome_unknown',
        reason: 'provider-secret',
        providerReference: 'private-reference',
      };
}
const invoke = async (raw: unknown, token = capability(raw)) =>
  (await executeHarnessDispatch(
    JSON.parse(JSON.stringify(raw)),
    token,
    new AbortController().signal
  )) as any;
beforeEach(() => {
  output = [];
  cloudOutcome = failure = undefined;
  effects.clear();
  cloudInputs.length = contexts.length = 0;
  Object.assign(authority, { organizationId: runId });
});

const reads = [
  ['kilo.organizations', {}, [], [{ id: 'resource', name: 'Resource' }]],
  ['kilo.members', {}, [], [{ id: 'user', email: 'person@example.com', role: 'member' }]],
  ['kilo.repositories', {}, [], [{ id: 'repository', name: 'owner/repo' }]],
  ['kilo.usage', {}, {}, { totalCost: 12 }],
  ['kilo.sessions.search', { query: 'scope' }, [], [{ sessionId, title: 'Existing session' }]],
  [
    'kilo.sessions.attach',
    { sessionId },
    { sessionId, untrusted: true, messages: [] },
    { sessionId, untrusted: true, messages: [{ role: 'user', content: 'Selected context' }] },
  ],
  [
    'kilo.sessions.progress',
    { sessionId },
    { sessionId, status: 'idle' },
    { sessionId, status: 'running' },
  ],
] as const;
it.each(reads)(
  'returns actual and empty %s results without a dispatch timestamp',
  async (name, args, empty, actual) => {
    for (output of [empty, actual])
      expect(await invoke({ ...call(name, args), dispatchStartedAt: undefined })).toEqual({
        result: { status: 'succeeded', output },
      });
  }
);
it.each(reads)('rejects unsupported %s reconciliation', async (name, args) => {
  expect(await invoke({ ...call(name, args), type: 'reconcile' })).toMatchObject({
    error: { code: 'invalid_input', retryable: false },
  });
  expect(effects.size).toBe(0);
});
it.each(['kilo.organizations', 'kilo.members', 'kilo.repositories'])(
  'bounds and validates %s output',
  async name => {
    output = [{ id: 'resource', name: '界'.repeat(22000) }];
    expect((await invoke(call('kilo.organizations'))).error.code).toBe('limit_exceeded');
    for (output of [null, [{ token: 'provider-secret' }]])
      expect((await invoke(call(name))).error.code).toBe('invalid_output');
  }
);
it.each(
  mutations.flatMap(([name, args]) =>
    [false, true].flatMap(lost =>
      [null, runId].map(organizationId => ({ name, args, lost, organizationId }))
    )
  )
)(
  '$name preserves identity in $organizationId (response lost: $lost)',
  async ({ name, args, lost, organizationId }) => {
    Object.assign(authority, { organizationId });
    const input = call(`kilo.sessions.${name}`, args);
    for (const dispatchStartedAt of [undefined, null, -1, 0.5, '0']) {
      const raw = { ...input, dispatchStartedAt };
      const token = capability(dispatchStartedAt === undefined ? raw : input);
      expect((await invoke(raw, token)).error.code).toBe('invalid_input');
    }
    expect(effects.size).toBe(0);
    failure = lost ? new Error('provider-secret') : undefined;
    expect(await invoke(input)).toMatchObject(
      lost
        ? { error: { code: 'outcome_unknown', retryable: false } }
        : { result: { status: 'succeeded', output: { sessionId } } }
    );
    expect(contexts).toEqual([
      {
        user: { id: 'oauth/owner', blocked_reason: null },
        authViaToken: true,
        tokenSource: 'agent-harness',
        ip: null,
      },
    ]);
    jest.mocked(Date.now).mockReturnValue(originalTime + 120000);
    expect((await invoke({ ...input, type: 'reconcile' })).result).toMatchObject(
      name === 'stop'
        ? { status: 'outcome_unknown' }
        : { status: 'succeeded', output: { sessionId } }
    );
    expect(cloudInputs[1]).toHaveProperty('dispatchStartedAt', originalTime);
    expect([...effects.values()]).toEqual([1]);
  }
);
it.each(mutations)(
  'passes explicit absent identity for legacy %s reconciliation',
  async (name, args) => {
    const input = {
      ...call(`kilo.sessions.${name}`, args),
      type: 'reconcile',
      dispatchStartedAt: undefined,
    };
    expect(await invoke(input)).toMatchObject({
      error: { code: 'outcome_unknown', retryable: false },
    });
    expect(cloudInputs).toStrictEqual([
      { ...input.request, conversationId, operationId, dispatchStartedAt: undefined },
    ]);
    expect(effects.size).toBe(0);
  }
);
it.each(['account', 'membership', 'expiry', 'mint', 'signature'])(
  'rejects lost %s authority before effects',
  async loss => {
    const input = call('kilo.invite', { recipient: 'member@example.com', role: 'member' });
    const token = capability(input);
    if (loss === 'account') access.active = false;
    if (loss === 'membership') access.role = false;
    if (loss === 'expiry') access.expires = new Date(originalTime).toISOString();
    if (loss === 'mint')
      jest.spyOn(runtime, 'lookupThread').mockResolvedValueOnce(authority).mockResolvedValue(null);
    expect(await invoke(input, loss === 'signature' ? 'forged-token' : token)).toMatchObject({
      error: { code: 'access_revoked', retryable: false },
    });
    expect(effects.size).toBe(0);
  }
);
it.each([
  ['type', 'reconcile'],
  ['conversationId', runId],
  ['operationId', runId],
  ['runId', operationId],
  ['toolCallId', runId],
  ['dispatchStartedAt', originalTime + 1],
  ['request', { name: 'kilo.sessions.start', arguments: { prompt: 'Changed', modelId: 'model' } }],
])('rejects a changed signed %s', async (field, value) => {
  const input = call('kilo.sessions.start', mutations[0][1]);
  expect((await invoke({ ...input, [String(field)]: value }, capability(input))).error.code).toBe(
    'access_revoked'
  );
  expect(effects.size).toBe(0);
});
it.each([
  ['audience', 'another-service'],
  ['definitionVersion', '2'],
  ['target', { kind: 'client', clientId: runId }],
  ['inputDigest', '0'.repeat(64)],
])('rejects a valid signature with forged %s scope', async (field, value) => {
  const input = call('kilo.sessions.start', mutations[0][1]);
  const claims = jwt.decode(capability(input)) as jwt.JwtPayload;
  const token = jwt.sign(
    { ...claims, scope: { ...claims.scope, [String(field)]: value } },
    'test-signing-key'
  );
  expect((await invoke(input, token)).error.code).toBe('access_revoked');
  expect(effects.size).toBe(0);
});
it.each([
  ['app.currentScreen', {}],
  ['app.openScreen', { screen: 'preferences' }],
  ['app.setPreference', { name: 'showToolDetails', value: true }],
  ['app.notifications', {}],
  ['app.openSettings', {}],
  [
    'question.ask',
    {
      questionId: 'q',
      prompt: 'Choose',
      choices: [],
      minSelections: 0,
      maxSelections: 0,
      allowCancellation: true,
    },
  ],
  ['mcp.discover', {}],
  [
    'mcp.call',
    {
      serverId: 's',
      configurationVersion: '1',
      name: 'remote',
      definitionVersion: '1',
      arguments: {},
    },
  ],
  ['web.search', { query: 'test' }],
  ['web.retrieve', { url: 'https://example.com' }],
])('rejects %s outside the named Kilo boundary', async (name, args) => {
  expect(await invoke(call(String(name), args))).toMatchObject({
    error: { code: 'invalid_input', retryable: false },
  });
  expect(effects.size).toBe(0);
});
it.each([
  ['SERVICE_UNAVAILABLE', 'unavailable_tool', true],
  ['PRECONDITION_FAILED', 'unavailable_tool', false],
] as const)('preserves sanitized %s read recovery', async (code, expected, retryable) => {
  failure = new TRPCError({ code, message: 'provider-secret' });
  const result = await invoke(call());
  expect(result).toMatchObject({ error: { code: expected, retryable } });
  expect(JSON.stringify(result)).not.toContain('provider-secret');
  failure = undefined;
  expect(await invoke(call())).toEqual({ result: { status: 'succeeded', output: [] } });
});
it('preserves failed, denied, cancelled, and unknown outcomes without provider text', async () => {
  const input = call('kilo.sessions.start', mutations[0][1]);
  for (const retryable of [true, false]) {
    cloudOutcome = {
      status: 'failed',
      error: { code: 'unavailable_tool', message: 'provider-secret', retryable },
    };
    expect((await invoke(input)).result).toEqual({
      status: 'failed',
      error: {
        code: 'unavailable_tool',
        message: 'This tool is unavailable in the current context.',
        retryable,
      },
    });
  }
  for (const status of ['denied', 'cancelled']) {
    cloudOutcome = { status };
    expect((await invoke(input)).result).toEqual({ status });
  }
  cloudOutcome = {
    status: 'outcome_unknown',
    reason: 'provider-secret',
    providerReference: 'private-reference',
  };
  expect((await invoke(input)).result).toEqual({
    status: 'outcome_unknown',
    reason: 'Check the recorded outcome; do not repeat this mutation.',
    providerReference: operationId,
  });
});
it.each([
  { status: 'invalid' },
  { status: 'succeeded', output: { sessionId: '界'.repeat(22000) } },
])('keeps malformed or oversized mutation output uncertain', async outcome => {
  cloudOutcome = outcome;
  expect(await invoke(call('kilo.sessions.start', mutations[0][1]))).toMatchObject({
    error: { code: 'outcome_unknown', retryable: false },
  });
});
it('keeps invitation uncertainty distinct and reconciles without redispatch', async () => {
  const input = call('kilo.invite', { recipient: 'member@example.com', role: 'member' });
  expect((await invoke({ ...input, type: 'reconcile' })).result.status).toBe('outcome_unknown');
  failure = new Error('provider-secret');
  expect(await invoke(input)).toMatchObject({
    error: { code: 'outcome_unknown', retryable: false },
  });
  jest.mocked(Date.now).mockReturnValue(originalTime + 120000);
  expect((await invoke({ ...input, type: 'reconcile' })).result.output).toEqual({
    invitationId: toolCallId,
    emailQueued: true,
  });
  expect([...effects.values()]).toEqual([1]);
});
it.each(OrganizationRoleSchema.options)(
  'dispatches and reconciles invitations with the %s role',
  async role => {
    const input = call('kilo.invite', { recipient: 'member@example.com', role });
    const expected = {
      result: { status: 'succeeded', output: { invitationId: toolCallId, emailQueued: true } },
    };
    expect(await invoke(input)).toEqual(expected);
    expect(await invoke({ ...input, type: 'reconcile' })).toEqual(expected);
    expect([...effects.values()]).toEqual([1]);
  }
);
it.each(['execute', 'reconcile'])(
  'rejects an unsupported invitation role before %s',
  async type => {
    const input = {
      ...call('kilo.invite', { recipient: 'member@example.com', role: 'not-a-role' }),
      type,
    };
    expect(await invoke(input)).toEqual({
      error: {
        code: 'invalid_input',
        message: 'The operation input is invalid.',
        retryable: false,
      },
    });
    expect(effects.size).toBe(0);
  }
);
it.each([
  ['kilo.organizations', {}],
  ['kilo.invite', { recipient: 'member@example.com', role: 'member' }],
  ['kilo.sessions.start', mutations[0][1]],
] as const)('cancels %s before adapter dispatch', async (name, args) => {
  const input = call(name, args);
  const controller = new AbortController();
  controller.abort();
  expect(await executeHarnessDispatch(input, capability(input), controller.signal)).toEqual({
    result: { status: 'cancelled' },
  });
  expect(effects.size).toBe(0);
  expect(cloudInputs).toEqual([]);
});
it.each([
  ['kilo.invite', { recipient: 'member@example.com', role: 'member' }],
  ...mutations.map(([name, args]) => [`kilo.sessions.${name}`, args] as const),
] as const)('keeps %s uncertain when reconciliation aborts', async (name, args) => {
  const input = call(name, args);
  failure = new Error('provider-secret');
  expect(await invoke(input)).toMatchObject({
    error: { code: 'outcome_unknown', retryable: false },
  });
  expect([...effects.values()]).toEqual([1]);
  const priorInputs = cloudInputs.length;
  const reconcile = { ...input, type: 'reconcile' };
  const controller = new AbortController();
  controller.abort(new Error('private-abort-reason'));
  expect(await executeHarnessDispatch(reconcile, capability(reconcile), controller.signal)).toEqual(
    {
      error: {
        code: 'outcome_unknown',
        message: 'Check the recorded outcome; do not repeat this mutation.',
        retryable: false,
      },
    }
  );
  expect(cloudInputs).toHaveLength(priorInputs);
  expect([...effects.values()]).toEqual([1]);
  expect((await invoke(reconcile)).result.status).toBe(
    name === 'kilo.sessions.stop' ? 'outcome_unknown' : 'succeeded'
  );
  expect([...effects.values()]).toEqual([1]);
});
it('keeps an invitation effect uncertain when its response aborts', async () => {
  const input = call('kilo.invite', { recipient: 'member@example.com', role: 'member' });
  const controller = new AbortController();
  jest
    .spyOn(jest.requireMock<typeof Invitation>('./invitation'), 'executeHarnessInvitation')
    .mockImplementationOnce(async () => {
      effects.set('invitation', 1);
      controller.abort(new Error('provider-secret'));
      throw controller.signal.reason;
    });
  expect(await executeHarnessDispatch(input, capability(input), controller.signal)).toEqual({
    error: {
      code: 'outcome_unknown',
      message: 'Check the recorded outcome; do not repeat this mutation.',
      retryable: false,
    },
  });
  expect(await invoke({ ...input, type: 'reconcile' })).toEqual({
    result: { status: 'succeeded', output: { invitationId: toolCallId, emailQueued: true } },
  });
  expect([...effects.values()]).toEqual([1]);
});

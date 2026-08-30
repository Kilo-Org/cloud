import { beforeEach, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import { QuickChatAuthorityError } from '@kilocode/db/quick-chat-runtime';
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
import type * as Contract from './operation-contract';
import type * as Maintenance from './operation-maintenance';
import type { drainLegacyHistoryWithProgress } from './history';

const { HarnessOperationSchema, harnessOperationFailure } =
  jest.requireActual<typeof Contract>('./operation-contract');
const { executeHarnessMaintenance, retirement } =
  jest.requireActual<typeof Maintenance>('./operation-maintenance');
const effects = new Map<string, unknown>();
const identity = { conversationId, operationId };
const projection = {
  id: toolCallId,
  key: `agent-harness:${conversationId}:${toolCallId}`,
  role: 'assistant',
  content: 'Actual text',
  clientId: null,
  createdAt: new Date(originalTime).toISOString(),
};
const inputs = [
  { type: 'read', ...identity, purpose: 'read' },
  { type: 'history', ...identity, limit: 1 },
  { type: 'projection', ...identity, projection },
];
const purge = { type: 'retirement', ...identity, generation: 0 };
const now = originalTime / 1000;
function purgeToken(changes: Record<string, unknown> = {}) {
  const request = { type: 'purge', protocolVersion: 1, threadId: conversationId, generation: 0 };
  return jwt.sign(
    JSON.stringify({
      operation: 'purge',
      threadId: conversationId,
      generation: 0,
      dispatchId: operationId,
      inputDigest: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      iss: 'agent-harness',
      aud: 'agent-harness:maintenance',
      iat: now,
      exp: now + 60,
      ...changes,
    }),
    'test-signing-key'
  );
}
let fence: { thread_id: string; generation: number } | undefined;
const fences = { findFirst: async () => fence };
beforeEach(() => {
  fence = { thread_id: conversationId, generation: 0 };
  Object.assign(authority, { userId: 'oauth/owner', organizationId: runId });
  effects.clear();
  Object.assign(primary.query, { agent_harness_retirements: fences });
  Object.assign(runtime, {
    claimPending: async () => {
      effects.set('history', true);
      return [];
    },
    hasPending: async () => false,
    projectText: async (owner: unknown, value: { id: string; content: string }) => {
      effects.set(value.id, { owner, content: value.content });
      return value.id;
    },
  });
});
const invoke = async (raw: unknown, token = capability(raw)) => {
  try {
    const input = HarnessOperationSchema.parse(JSON.parse(JSON.stringify(raw)));
    if (input.type === 'retirement')
      return { status: 200, body: { result: await retirement(input, token) } as any };
    if (input.type !== 'read' && input.type !== 'history' && input.type !== 'projection')
      throw new TRPCError({ code: 'BAD_REQUEST' });
    return { status: 200, body: (await executeHarnessMaintenance(input, token)) as any };
  } catch (error) {
    return { status: 400, body: harnessOperationFailure(error) as any };
  }
};

it.each([null, runId])(
  'authorizes history and bound projection in context %s',
  async organizationId => {
    Object.assign(authority, { organizationId });
    expect((await invoke(inputs[0])).body).toEqual({ result: authority });
    expect((await invoke(inputs[1])).body).toEqual({
      result: { deliveries: [], backlog: 'drained' },
    });
    expect((await invoke(inputs[2])).body).toEqual({ result: toolCallId });
    expect(effects.get(toolCallId)).toEqual({ owner: authority, content: 'Actual text' });
  }
);
it.each<[string, () => unknown]>([
  ['expired token', () => jest.spyOn(Date, 'now').mockReturnValue(originalTime + 60000)],
  ['expired grant', () => Object.assign(access, { expires: new Date(originalTime).toISOString() })],
  [
    'revoked grant',
    async () => {
      const grants = primary.query.agent_harness_conversation_grants;
      const grant = await grants.findFirst();
      jest.spyOn(grants, 'findFirst').mockResolvedValue({ ...grant, revoked_at: 'revoked' } as any);
    },
  ],
  ['removed membership', () => Object.assign(access, { role: false })],
  ['missing primary authority', () => Object.assign(access, { active: false })],
])('denies %s before protected access', async (_name, invalidate) => {
  const requests = inputs.map(input => ({ input, token: capability(input) }));
  await invalidate();
  for (const { input, token } of requests)
    expect((await invoke(input, token)).body.error).toMatchObject({
      code: 'access_revoked',
      retryable: false,
    });
  expect(effects.size).toBe(0);
});
it.each(inputs)('rejects changed $type scope and caller owner substitution', async input => {
  const token = capability(input);
  const changed =
    input.type === 'read'
      ? { purpose: 'import' }
      : input.type === 'history'
        ? { limit: 2 }
        : { projection: { ...projection, content: 'forged' } };
  for (const fields of [
    { conversationId: runId },
    { operationId: runId },
    { ownerUserId: 'forged' },
    changed,
  ])
    expect((await invoke({ ...input, ...fields }, token)).status).not.toBe(200);
  expect(effects.size).toBe(0);
});
it.each([{ userId: 'forged' }, { organizationId: null }, { generation: 1 }, { threadId: runId }])(
  'rejects validly signed substituted authority %j',
  async changed => {
    for (const input of inputs) {
      const claims = jwt.decode(capability(input)) as jwt.JwtPayload;
      const token = jwt.sign(
        { ...claims, authority: { ...authority, ...changed } },
        'test-signing-key'
      );
      expect((await invoke(input, token)).body.error.code).toBe('access_revoked');
    }
    expect(effects.size).toBe(0);
  }
);
it('keeps an empty leased history batch pending', async () => {
  Object.assign(runtime, { hasPending: async () => true });
  expect((await invoke(inputs[1])).body).toEqual({
    result: { deliveries: [], backlog: 'pending' },
  });
});
it.each(['acknowledged', 'retry', 'rejected'])('preserves history delivery %s', async status => {
  Object.assign(runtime, {
    claimPending: async () => [{ ...authority, ...projection, leaseToken: operationId }],
    withClaim: async () => {
      if (status === 'rejected') throw new QuickChatAuthorityError();
      return status === 'acknowledged';
    },
    hasPending: async () => status !== 'acknowledged',
  });
  expect((await invoke(inputs[1])).body).toEqual({
    result: {
      deliveries: [{ id: toolCallId, status }],
      backlog: status === 'acknowledged' ? 'drained' : 'pending',
    },
  });
});
it.each<[string, Record<string, unknown> | Error, 'acknowledged' | 'retry']>([
  ['matching receipt', {}, 'acknowledged'],
  ['non-durable receipt', { durable: false }, 'retry'],
  ['wrong message receipt', { messageId: runId }, 'retry'],
  ['wrong thread receipt', { threadId: runId }, 'retry'],
  ['wrong owner receipt', { userId: 'oauth/other' }, 'retry'],
  ['wrong context receipt', { organizationId: null }, 'retry'],
  ['wrong generation receipt', { generation: 1 }, 'retry'],
  ['transport failure', new Error('secret-transport-details'), 'retry'],
])('delivers signed history with %s', async (_name, reply, status) => {
  jest.replaceProperty(process, 'env', {
    AGENT_HARNESS_API_URL: 'https://harness.example/ignored',
  });
  const claim = {
    ...authority,
    ...projection,
    createdAt: '2026-04-29 01:16:12.945+00',
    leaseToken: operationId,
  };
  const pending = new Map([[claim.id, claim]]);
  Object.assign(runtime, {
    claimPending: async () => [...pending.values()],
    withClaim: async (claimed, work) => work(async () => pending.delete(claimed.id)),
    hasPending: async () => pending.size > 0,
  } satisfies Parameters<typeof drainLegacyHistoryWithProgress>[0]);
  const sent = Promise.withResolvers<Request>();
  const response = Promise.withResolvers<Response>();
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    sent.resolve(new Request(url, init));
    return response.promise;
  });
  const delivery = invoke(inputs[1]);
  const request = await Promise.race([
    sent.promise,
    delivery.then(() => {
      throw new Error('History finished before signed delivery');
    }),
  ]);
  const pendingBeforeReceipt = [...pending.values()];
  if (reply instanceof Error) response.reject(reply);
  else
    response.resolve(
      Response.json({ ...authority, messageId: toolCallId, durable: true, ...reply })
    );
  expect(await delivery).toEqual({
    status: 200,
    body: {
      result: {
        deliveries: [{ id: toolCallId, status }],
        backlog: status === 'acknowledged' ? 'drained' : 'pending',
      },
    },
  });
  expect(pendingBeforeReceipt).toEqual([claim]);
  expect([...pending.values()]).toEqual(status === 'acknowledged' ? [] : [claim]);
  expect(request.url).toBe('https://harness.example/internal/maintenance');
  expect(request.method).toBe('POST');
  expect(request.redirect).toBe('error');
  expect(request.headers.get('accept')).toBe('application/json');
  expect(request.headers.get('content-type')).toBe('application/json');
  expect(request.headers.get('x-internal-api-key')).toBe('test-service-key');
  const body = await request.text();
  expect(JSON.parse(body)).toEqual({
    type: 'importLegacy',
    protocolVersion: 1,
    authority,
    message: {
      id: toolCallId,
      role: 'assistant',
      content: 'Actual text',
      clientId: null,
      createdAt: '2026-04-29T01:16:12.945Z',
      provenance: 'legacy',
      parts: [{ type: 'text', text: 'Actual text' }],
    },
  });
  expect(
    jwt.verify(request.headers.get('authorization')?.slice(7) ?? '', 'test-signing-key', {
      algorithms: ['HS256'],
      issuer: 'agent-harness',
      audience: 'agent-harness:maintenance',
    })
  ).toEqual({
    ...authority,
    operation: 'importLegacy',
    dispatchId: toolCallId,
    inputDigest: createHash('sha256').update(body).digest('hex'),
    iss: 'agent-harness',
    aud: 'agent-harness:maintenance',
    iat: now,
    exp: now + 60,
  });
});
it.each([{ ids: [toolCallId, runId] }, { ids: ['invalid-id'] }])(
  'rejects invalid history delivery output $ids',
  async ({ ids }) => {
    Object.assign(runtime, {
      claimPending: async () => ids.map(id => ({ ...authority, ...projection, id })),
      withClaim: async () => true,
    });
    expect((await invoke(inputs[1])).body.error.code).toBe('invalid_output');
  }
);
it.each<[Partial<typeof projection>, string]>([
  [{ key: `agent-harness:${runId}:${toolCallId}` }, 'invalid_input'],
  [{ key: `agent-harness:${conversationId}:${runId}` }, 'invalid_input'],
  [{ content: 'é'.repeat(32768) }, 'limit_exceeded'],
])('rejects invalid projection before writing (case %#)', async (changed, code) => {
  expect(
    (await invoke({ ...inputs[2], projection: { ...projection, ...changed } })).body.error.code
  ).toBe(code);
  expect(effects.size).toBe(0);
});
it.each(['invalid-id', runId])('rejects a mismatched projection result %s', async id => {
  Object.assign(runtime, { projectText: async () => id });
  expect((await invoke(inputs[2])).body.error.code).toBe('invalid_output');
});
it('bounds authority output in UTF-8 bytes', async () => {
  authority.userId = 'é'.repeat(32768);
  expect((await invoke(inputs[0])).body.error.code).toBe('limit_exceeded');
});
it.each(['claimPending', 'hasPending', 'projectText'])(
  'denies late primary revocation in %s',
  async method => {
    Object.assign(runtime, {
      [method]: async () => {
        throw new QuickChatAuthorityError();
      },
    });
    expect((await invoke(inputs[method === 'projectText' ? 2 : 1])).body.error).toMatchObject({
      code: 'access_revoked',
      retryable: false,
    });
  }
);
it.each(inputs)('sanitizes primary storage failures for $type', async input => {
  jest
    .spyOn(primary.query.agent_harness_conversation_grants, 'findFirst')
    .mockRejectedValue(new Error('secret-database-url'));
  expect((await invoke(input)).body).toEqual({
    error: {
      code: 'storage_unavailable',
      message: 'The operation service is unavailable. Retry synchronization.',
      retryable: true,
    },
  });
  expect(effects.size).toBe(0);
});
it('accepts an exact fenced purge without a live grant and rejects altered requests', async () => {
  const token = purgeToken();
  access.expires = new Date(originalTime).toISOString();
  access.active = access.role = false;
  expect((await invoke(purge, token)).body).toEqual({ result: { retired: true } });
  for (const changed of [{ ...purge, generation: 1 }, { ...purge, operationId: runId }, call()])
    expect((await invoke(changed, token)).status).not.toBe(200);
});
it.each([
  { operation: 'importLegacy' },
  { threadId: runId },
  { generation: 1 },
  { dispatchId: runId },
  { inputDigest: '0'.repeat(64) },
  { iss: 'other' },
  { aud: 'agent-harness:operations' },
  { aud: ['agent-harness:maintenance', 'other'] },
  { iat: now + 1 },
  { iat: now - 61 },
  { exp: now },
  { exp: now + 61 },
  { exp: undefined },
  { iat: undefined },
  { authority },
])('rejects invalid signed purge claims %j before fence access', async changed => {
  const lookup = jest.spyOn(fences, 'findFirst');
  expect((await invoke(purge, purgeToken(changed))).body.error).toMatchObject({
    code: 'access_revoked',
    retryable: false,
  });
  expect(lookup).not.toHaveBeenCalled();
});
it.each([
  undefined,
  { thread_id: runId, generation: 0 },
  { thread_id: conversationId, generation: 1 },
])('requires the exact primary purge fence %j', async value => {
  fence = value;
  expect((await invoke(purge, purgeToken())).body.error.code).toBe('access_revoked');
});

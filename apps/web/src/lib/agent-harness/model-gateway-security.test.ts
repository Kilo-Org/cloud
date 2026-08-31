import { beforeEach, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import * as fixtures from './operation-test-fixture';
import { harnessInputDigest } from './authorization';
import type * as Gateway from './model-gateway';
import type * as Route from '@/app/api/internal/agent-harness/model/route';

const { authority, conversationId, operationId, originalTime, primary, runId } = fixtures;
jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://app.example',
  ORGANIZATION_ID_HEADER: 'x-kilocode-organizationid',
}));
jest.mock('@/lib/utils.server', () => ({ warnExceptInTest: jest.fn() }));
const { harnessModelScope } = jest.requireActual<typeof Gateway>('./model-gateway');
const { POST } = jest.requireActual<typeof Route>('@/app/api/internal/agent-harness/model/route');
const completion = {
  model: 'paid/model',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  stream: true,
  max_tokens: 128,
};
const chunk = {
  id: 'generation-1',
  model: completion.model,
  created: 1,
  choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.002 },
};
const outputHeaders = {
  'content-type': 'text/event-stream',
  'request-id': 'request-1',
  authorization: 'upstream-secret',
};
const sse = (data = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`) =>
  new Response(data, { headers: outputHeaders });
const requests: Request[] = [];
let gateway: () => Response;
function capability(
  body: unknown,
  context: unknown = authority,
  scopePatch: Record<string, unknown> = {}
) {
  const input = { conversationId, operationId, runId, completion: body };
  const scope = {
    ...harnessModelScope({ ...input, completion }),
    inputDigest: harnessInputDigest(input),
    ...scopePatch,
  };
  return jwt.sign({ grantId: runId, authority: context, scope }, 'test-signing-key', {
    issuer: 'agent-harness',
    audience: scope.audience,
    expiresIn: 60,
  });
}
function invoke(
  body: unknown = completion,
  token = capability(completion),
  init: RequestInit = {}
) {
  const request = new Request('https://app.example/api/internal/agent-harness/model', {
    method: 'POST',
    body: JSON.stringify(body),
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': 'test-service-key',
      authorization: `Bearer ${token}`,
      'x-agent-harness-conversation-id': conversationId,
      'x-agent-harness-operation-id': operationId,
      'x-agent-harness-run-id': runId,
      'x-kilocode-organizationid': 'forged-org',
      'x-kilocode-feature': 'forged-feature',
      ...init.headers,
    },
  });
  return POST(request);
}
beforeEach(() => {
  requests.length = 0;
  gateway = () => sse();
  const user = { id: authority.userId, blocked_reason: null, api_token_pepper: 'current-pepper' };
  jest.spyOn(primary.query.kilocode_users, 'findFirst').mockResolvedValue(user);
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    requests.push(new Request(url, init));
    return gateway();
  });
});

it.each([
  'capability header',
  'grant revocation',
  'generation',
  'blocked user',
  'messages',
  'conversation',
  'operation',
])('blocks %s before inference', async reason => {
  const token = capability(completion);
  if (reason === 'grant revocation') {
    const grants = primary.query.agent_harness_conversation_grants;
    jest.spyOn(grants, 'findFirst').mockResolvedValue({
      ...(await grants.findFirst()),
      revoked_at: new Date(originalTime).toISOString(),
    } as any);
  }
  if (reason === 'generation') {
    const registry = primary.query.agent_harness_conversation_registry;
    jest
      .spyOn(registry, 'findFirst')
      .mockResolvedValue({ ...(await registry.findFirst()), generation: 1 });
  }
  if (reason === 'blocked user')
    jest.spyOn(primary.query.kilocode_users, 'findFirst').mockResolvedValue({
      id: authority.userId,
      blocked_reason: 'private-block-details',
    } as any);
  const headers: Record<string, string> = {};
  if (reason === 'capability header') headers.authorization = '';
  if (reason === 'conversation') headers['x-agent-harness-conversation-id'] = operationId;
  if (reason === 'operation') headers['x-agent-harness-operation-id'] = runId;
  const body =
    reason === 'messages'
      ? { ...completion, messages: [{ role: 'user', content: 'Forged' }] }
      : completion;
  const response = await invoke(body, token, { headers });
  expect(response.status).toBe(
    reason.includes('service') || reason === 'capability header' ? 401 : 403
  );
  expect(await response.json()).toMatchObject({
    error: { type: 'access_revoked', retryable: false },
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(requests).toEqual([]);
});
it.each([
  { audience: 'agent-harness:operations' },
  { operation: 'read' },
  { definitionVersion: '2' },
  { dispatchId: runId },
  { inputDigest: '0'.repeat(64) },
  { target: { kind: 'client', clientId: operationId } },
])('rejects a capability for a different scope %j', async scope => {
  const response = await invoke(completion, capability(completion, authority, scope));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: { type: 'access_revoked', retryable: false },
  });
  expect(requests).toEqual([]);
});
it.each([{ model: ' ' }, { model: null }, { max_tokens: 0 }, { max_tokens: 1.5 }])(
  'rejects invalid inference input %j',
  async patch => {
    const body = { ...completion, ...patch };
    expect((await invoke(body, capability(body))).status).toBe(400);
    expect(requests).toEqual([]);
  }
);
it.each([
  [400, 'invalid_input', false],
  [401, 'access_revoked', false],
  [402, 'limit_exceeded', false],
  [403, 'access_revoked', false],
  [404, 'invalid_input', false],
  [408, 'storage_unavailable', true],
  [429, 'storage_unavailable', true],
  [503, 'storage_unavailable', true],
] as const)('preserves HTTP and stream error %s', async (code, type, retryable) => {
  for (const streaming of [false, true]) {
    const error = JSON.stringify({
      error: { code, message: 'upstream-secret', metadata: { authorization: 'credential' } },
    });
    gateway = () =>
      streaming ? sse(`data: ${error}\n\ndata: [DONE]\n\n`) : new Response(error, { status: code });
    const response = await invoke();
    const text = await response.text();
    expect(response.status).toBe(streaming ? 200 : code);
    expect(text).toContain(`"code":${code}`);
    expect(text).toContain(`"type":"${type}"`);
    expect(text).toContain(`"retryable":${retryable}`);
    expect(text).not.toMatch(/upstream-secret|credential|\[DONE\]/);
  }
  expect(requests).toHaveLength(2);
});
it.each([
  [0, 'data: private-malformed\n\n', 422],
  [1, 'data: {"choices":[{"delta":{"content":["private-malformed"]}}]}\n\n', 422],
  [2, `data: ${'x'.repeat(1024 * 1024)}\n\n`, 413],
] as const)('rejects malformed or oversized streams (case %s)', async (_case, data, code) => {
  gateway = () => sse(data);
  const text = await (await invoke()).text();
  expect(text).toContain(`"code":${code}`);
  expect(text).not.toContain('private-malformed');
});
it('rejects wrong upstream media without forwarding its body', async () => {
  gateway = () =>
    new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } });
  const response = await invoke();
  expect(response.status).toBe(422);
  const text = await response.text();
  expect(text).toContain('"retryable":false');
  expect(text).not.toContain('private');
});
it.each([''])('preserves empty output %j', async data => {
  gateway = () => sse(data);
  const response = await invoke();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(data);
});
it('sanitizes a failed upstream read after progressive output', async () => {
  const logs = (['log', 'info', 'debug', 'warn', 'error'] as const).map(method =>
    jest.spyOn(console, method).mockImplementation(() => undefined)
  );
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  gateway = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          upstream = controller;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
      }),
      { headers: outputHeaders }
    );
  const response = await invoke();
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"content":"Hello"');
  const token = requests[0].headers.get('authorization')!;
  upstream.error(new TypeError(`private-read-error ${token}`));
  const text = new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('"code":503');
  expect(text).toContain('"retryable":true');
  expect(text).not.toContain(token);
  expect(text).not.toMatch(/private-read-error|\[DONE\]/);
  expect((await reader.read()).done).toBe(true);
  expect(requests[0].signal.aborted).toBe(true);
  expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(token);
});
it('rejects oversized request bytes and empty bodies', async () => {
  expect(
    (await invoke(completion, capability(completion), { body: '界'.repeat(350000) })).status
  ).toBe(413);
  expect((await invoke(completion, capability(completion), { body: null })).status).toBe(400);
  expect(requests).toEqual([]);
});
it.each([[0, 'private-malformed']] as const)(
  'rejects malformed JSON and UTF-8 requests (case %s)',
  async (_case, body) => {
    const response = await invoke(completion, capability(completion), { body });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('"retryable":false');
    expect(text).not.toContain('private-malformed');
    expect(requests).toEqual([]);
  }
);
it.each([['deadline', 503]] as const)('cancels inference through the %s', async (target, code) => {
  expect(
    (await invoke(completion, capability(completion), { signal: AbortSignal.abort('private') }))
      .status
  ).toBe(499);
  expect(requests).toEqual([]);
  const cancelled = Promise.withResolvers<void>();
  gateway = () =>
    new Response(new ReadableStream({ cancel: () => cancelled.resolve() }), {
      headers: outputHeaders,
    });
  const abort = new AbortController();
  if (target === 'deadline') jest.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
  const response = await invoke(completion, capability(completion), {
    signal: undefined,
  });
  const output = response.text();
  abort.abort(new Error('private'));
  const text = await output;
  expect(text).toContain(`"code":${code}`);
  expect(text).not.toMatch(/private|\[DONE\]/);
  await cancelled.promise;
  expect(requests[0].signal.aborted).toBe(true);
});

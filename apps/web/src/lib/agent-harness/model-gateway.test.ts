import { beforeEach, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import * as fixtures from './operation-test-fixture';
import { harnessInputDigest } from './authorization';
import type * as Gateway from './model-gateway';
import type * as Route from '@/app/api/internal/agent-harness/model/route';

const { access, authority, conversationId, operationId, originalTime, primary, runId } = fixtures;
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
function capability(body: unknown, context: unknown = authority) {
  const input = { conversationId, operationId, runId, completion: body };
  const scope = {
    ...harnessModelScope({ ...input, completion }),
    inputDigest: harnessInputDigest(input),
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
  ['paid/model', runId],
  ['provider/model:free', null],
  ['direct-byok/model', runId],
] as const)('streams billed SDK output for %s in %s', async (model, organizationId) => {
  const registry = primary.query.agent_harness_conversation_registry;
  jest
    .spyOn(registry, 'findFirst')
    .mockResolvedValue({ ...(await registry.findFirst()), organization_id: organizationId } as any);
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  gateway = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          upstream = controller;
          const data = JSON.stringify(chunk, null, 2).replaceAll('\n', '\ndata: ');
          controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
        },
      }),
      { headers: outputHeaders }
    );
  const replies: Response[] = [];
  const provider = createOpenAICompatible({
    name: 'harness',
    baseURL: 'https://fixed.example',
    fetch: async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      const response = await invoke(body, capability(body, { ...authority, organizationId }));
      replies.push(response.clone());
      return response;
    },
  });
  const result = streamText({
    model: provider(model),
    messages: completion.messages,
    maxOutputTokens: 128,
    maxRetries: 0,
  });
  const reader = result.textStream.getReader();
  expect((await reader.read()).value).toBe('Hello');
  upstream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  upstream.close();
  expect((await reader.read()).done).toBe(true);
  expect((await result.response).id).toBe('generation-1');
  expect(await result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  const output = await replies[0].text();
  expect(output).toContain(JSON.stringify(chunk));
  expect(replies[0].headers.get('authorization')).toBeNull();
  expect(replies[0].headers.get('request-id')).toBe('request-1');
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('https://app.example/api/openrouter/chat/completions');
  expect(requests[0].redirect).toBe('error');
  expect(await requests[0].json()).toMatchObject({ model, max_tokens: 128, stream: true });
  expect(requests[0].headers.get('x-kilocode-organizationid')).toBe(organizationId);
  expect(requests[0].headers.get('x-kilocode-feature')).toBe('quick-chat');
  expect(requests[0].headers.get('x-kilo-request')).toBe(operationId);
  expect(requests[0].headers.get('x-kilocode-taskid')).toBe(runId);
  expect(requests[0].headers.get('x-kilo-session')).toBe(conversationId);
  expect(requests[0].headers.get('x-internal-api-key')).toBeNull();
  const token = requests[0].headers.get('authorization')!.slice(7);
  expect(jwt.verify(token, 'test-signing-key')).toEqual({
    env: 'test',
    version: 3,
    tokenSource: 'agent-harness',
    kiloUserId: 'oauth/owner',
    apiTokenPepper: 'current-pepper',
    iat: Math.floor(originalTime / 1000),
    exp: Math.floor(originalTime / 1000) + 300,
  });
  expect(output).not.toContain(token);
  expect(JSON.stringify(await result.response)).not.toContain(token);
});
it.each([
  'service',
  'wrong service',
  'signature',
  'capability expiry',
  'grant expiry',
  'role',
  'retirement',
  'input',
  'context',
  'run',
])('blocks %s before inference', async reason => {
  let token = capability(completion);
  if (reason === 'capability expiry') jest.mocked(Date.now).mockReturnValue(originalTime + 60000);
  if (reason === 'grant expiry') access.expires = new Date(originalTime).toISOString();
  if (reason === 'role') access.role = false;
  if (reason === 'retirement') access.active = false;
  if (reason === 'signature') token = 'ordinary-client-token';
  if (reason === 'context')
    token = capability(completion, { ...authority, organizationId: operationId });
  const headers: Record<string, string> = {};
  if (reason.includes('service'))
    headers['x-internal-api-key'] = reason === 'service' ? '' : 'wrong';
  if (reason === 'run') headers['x-agent-harness-run-id'] = operationId;
  const body = reason === 'input' ? { ...completion, model: 'forged/model' } : completion;
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
  { model: '' },
  { messages: [] },
  { stream: false },
  { max_tokens: 8193 },
  { max_completion_tokens: 99999 },
  { n: 2 },
  { tools: [{ type: 'web_search' }] },
  { plugins: [{ id: 'web' }] },
])('rejects invalid inference input %j', async patch => {
  const body = { ...completion, ...patch };
  expect((await invoke(body, capability(body))).status).toBe(400);
  expect(requests).toEqual([]);
});
it('rejects invalid upstream UTF-8 without a retryable transport error', async () => {
  gateway = () => new Response(new Uint8Array([0xc3, 0x28]), { headers: outputHeaders });
  const text = await (await invoke()).text();
  expect(text).toContain('"code":422');
  expect(text).toContain('"retryable":false');
});
it('sanitizes retryable transport failures', async () => {
  gateway = () => {
    throw new TypeError('transport-secret');
  };
  const response = await invoke();
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(text).toContain('"retryable":true');
  expect(text).not.toContain('transport-secret');
});
it.each(['data: [DONE]\n\n'])('preserves empty output %j', async data => {
  gateway = () => sse(data);
  const response = await invoke();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(data);
});
it.each([[1, new Uint8Array([0xc3, 0x28])]] as const)(
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
it.each([
  ['request', 499],
  ['reader', null],
] as const)('cancels inference through the %s', async (target, code) => {
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
  const response = await invoke(completion, capability(completion), {
    signal: target === 'request' ? abort.signal : undefined,
  });
  if (target === 'reader') await response.body!.cancel();
  else {
    const output = response.text();
    abort.abort(new Error('private'));
    const text = await output;
    expect(text).toContain(`"code":${code}`);
    expect(text).not.toMatch(/private|\[DONE\]/);
  }
  await cancelled.promise;
  expect(requests[0].signal.aborted).toBe(true);
});

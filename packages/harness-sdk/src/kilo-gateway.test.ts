import { Chunk, Effect, Either } from 'effect';
import { expect, it } from 'vitest';
import type { FetchLike, HttpRequest } from './fetch.js';
import { layerKiloGateway, type OrgContext } from './kilo-gateway.js';
import { ModelClient } from './model.js';
import { assemble } from './prompt.js';
import type { Turn } from './turn.js';

const turn = (role: Turn['role'], content: string): Turn => ({
  id: `trn_${content}`,
  sessionId: 'ses_1',
  role,
  content,
});

const reply = JSON.stringify({
  content: [{ type: 'text', text: 'hi' }],
  usage: {
    input_tokens: 7,
    output_tokens: 3,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 100,
  },
});

const call = async (org: OrgContext, response: { ok: boolean; status: number; body: string }) => {
  const sent: { url?: string; request?: HttpRequest } = {};
  const fetchLike: FetchLike = (url, request) => {
    sent.url = url;
    sent.request = request;
    return Promise.resolve({ ...response, text: () => Promise.resolve(response.body) });
  };
  const request = {
    prompt: assemble({
      system: 'sys',
      turns: Chunk.fromIterable([turn('user', 'a'), turn('user', 'b')]),
    }),
    model: 'claude-opus-5',
    maxTokens: 1024,
  };
  const result = await ModelClient.pipe(
    Effect.flatMap(client => client.send(request)),
    Effect.either,
    Effect.provide(
      layerKiloGateway({ baseUrl: 'https://app.kilocode.ai/', token: 'tok', org, fetch: fetchLike })
    ),
    Effect.runPromise
  );
  return { sent, result };
};

const ok = { ok: true, status: 200, body: reply };

it('posts to the gateway messages endpoint with a bearer token', async () => {
  const { sent } = await call({ kind: 'personal' }, ok);
  expect(sent.url).toBe('https://app.kilocode.ai/api/gateway/v1/messages');
  expect(sent.request?.headers['authorization']).toBe('Bearer tok');
  expect(sent.request?.headers).not.toHaveProperty('x-kilocode-organizationid');
});

it('names the organization when the context is an organization', async () => {
  const { sent } = await call({ kind: 'organization', id: 'org_1' }, ok);
  expect(sent.request?.headers['x-kilocode-organizationid']).toBe('org_1');
});

it('marks a cache breakpoint on the system block and on the last message', async () => {
  const { sent } = await call({ kind: 'personal' }, ok);
  const body: unknown = JSON.parse(sent.request?.body ?? '');
  expect(body).toMatchObject({
    system: [{ cache_control: { type: 'ephemeral' } }],
    messages: [
      { content: [{ text: 'a' }] },
      { content: [{ cache_control: { type: 'ephemeral' } }] },
    ],
  });
});

it('reads the token counts out of the reply', async () => {
  const { result } = await call({ kind: 'personal' }, ok);
  expect(Either.getOrThrow(result)).toEqual({
    content: 'hi',
    usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 900, cacheWriteTokens: 100 },
  });
});

it('reports the status when the gateway rejects the call', async () => {
  const { result } = await call(
    { kind: 'personal' },
    { ok: false, status: 402, body: 'no credit' }
  );
  expect(result).toMatchObject({ left: { reason: 'status', status: 402 } });
});

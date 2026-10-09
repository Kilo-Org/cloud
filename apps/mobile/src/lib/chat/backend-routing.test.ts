import { type FetchLike, type ModelClientService } from '@kilocode/harness-sdk';
import { Effect, Schedule, Stream } from 'effect';
import { expect, it, vi } from 'vitest';

import { routedModelClient } from './backend-routing';
import { type StoredChatBackend } from './backend-store';
import { backendTargetId } from './backend-target';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

async function* responseStream() {
  await Promise.resolve();
  yield 'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\n';
}

async function responseText(): Promise<string> {
  await Promise.resolve();
  return '';
}

it.each(['max_completion_tokens', 'max_tokens'] as const)(
  'routes the configured %s field into an actual upstream request',
  async completionTokenField => {
    const backend: StoredChatBackend = {
      id: 'server',
      revision: 1,
      name: 'Custom',
      baseUrl: 'https://provider.example/v1',
      apiKind: 'chat_completions',
      completionTokenField,
      apiKey: 'custom-key',
      headers: {},
      models: [{ id: 'upstream', name: 'Upstream', tools: false }],
      allowLocalHttp: false,
    };
    const fetch = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      text: responseText,
      stream: responseStream,
    });
    const kiloStream = vi.fn<ModelClientService['stream']>(() => Stream.empty);
    const client = routedModelClient({
      kilo: { stream: kiloStream },
      retry: { schedule: Schedule.recurs(0) },
      profiles: () => [backend],
      fetch,
      headers: profile => ({ authorization: `Bearer ${profile.apiKey}` }),
      validateTransport: () => undefined,
    });
    const events = await Effect.runPromise(
      Stream.runCollect(
        client.stream({
          model: backendTargetId(backend, 'upstream'),
          maxTokens: 321,
          prompt: {
            system: [],
            messages: [{ role: 'user', cache: false, parts: [{ kind: 'text', text: 'Question' }] }],
          },
        })
      )
    );
    expect([...events]).toMatchObject([
      { kind: 'delta', text: 'Answer' },
      { kind: 'done', stop: 'end' },
    ]);
    expect(kiloStream).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe('https://provider.example/v1/chat/completions');
    expect(call?.[1].headers).toMatchObject({ authorization: 'Bearer custom-key' });
    const body: unknown = JSON.parse(call?.[1].body ?? '{}');
    expect(body).toMatchObject({
      model: 'upstream',
      messages: [{ role: 'user', content: 'Question' }],
    });
    expect(body).toHaveProperty(completionTokenField, 321);
    expect(body).not.toHaveProperty(
      completionTokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
    );
  }
);

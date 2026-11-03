/* eslint-disable typescript-eslint/consistent-type-assertions, typescript-eslint/require-await, require-await -- a llama.rn context is a JSI object: a test double can only be built by asserting its shape */
import { type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Stream } from 'effect';
import { expect, it, vi } from 'vitest';

import { type GgufContext, ggufModelClient } from './gguf-client';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

const request: ModelRequest = {
  model: 'a',
  maxTokens: 4096,
  effort: 'high',
  prompt: {
    system: [{ text: 'Be brief.', cache: false }],
    messages: [{ role: 'user', cache: false, parts: [{ kind: 'text', text: 'Hi' }] }],
  },
};

it('streams the thinking apart from the answer when thinking is on', async () => {
  const context = {
    model: { chatTemplates: { llamaChat: false, jinja: { default: true } } },
    completion: async (_params: unknown, onToken?: (data: unknown) => void) => {
      onToken?.({ token: '<think>', reasoning_content: '', accumulated_text: '<think>' });
      onToken?.({ token: 'Hm', reasoning_content: 'Hm', accumulated_text: '<think>Hm' });
      onToken?.({ token: 'Hi', reasoning_content: 'Hm', content: 'Hi', accumulated_text: 'x' });
      return {
        text: '<think>Hm</think>Hi',
        content: 'Hi',
        reasoning_content: 'Hm',
        accumulated_text: '<think>Hm</think>Hi',
        tokens_evaluated: 7,
        tokens_predicted: 3,
        stopped_eos: true,
      };
    },
    stopCompletion: async () => undefined,
    release: async () => undefined,
  } as unknown as GgufContext;
  const { client } = ggufModelClient({
    runtime: { init: async () => context, gpu: false },
    fileOf: () => ({ path: '/m/a.gguf', contextWindow: 2048, tools: false, projector: undefined }),
  });

  const events = await Effect.runPromise(Stream.runCollect(client.stream(request)));

  expect(events.flatMap(event => (event.kind === 'reasoning' ? [event.text] : []))).toEqual(['Hm']);
  expect(events.flatMap(event => (event.kind === 'delta' ? [event.text] : []))).toEqual(['Hi']);
});

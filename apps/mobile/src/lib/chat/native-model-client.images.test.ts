import { type ModelRequest, type PromptMessage } from '@kilocode/harness-sdk';
import { Effect, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_NOT_SENT,
  type NativeAvailability,
  type NativeModelBridge,
  nativeModelClient,
  type NativeModelEvent,
} from './native-model-client';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

const READS_IMAGES: NativeAvailability = {
  status: 'available',
  modelId: 'apple-system-language-model',
  contextWindow: 4096,
  maxOutputTokens: 1000,
  systemInstructions: true,
  tokenCounting: true,
  images: true,
};

/** A native module that answers every request at once and records what it got. */
function fakeBridge(availability: NativeAvailability) {
  const listeners = new Set<(event: NativeModelEvent) => void>();
  const bridge = {
    availability: vi.fn<NativeModelBridge['availability']>().mockResolvedValue(availability),
    generate: vi.fn(async (request: Parameters<NativeModelBridge['generate']>[0]) => {
      await Promise.resolve();
      for (const listener of listeners) {
        listener({ id: request.id, kind: 'done', stop: 'end', usageSource: 'reported' });
      }
    }),
    cancel: vi.fn<NativeModelBridge['cancel']>().mockResolvedValue(undefined),
    addListener: (_name: 'onModelEvent', listener: (event: NativeModelEvent) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
  } satisfies NativeModelBridge;
  return bridge;
}

const requestOf = (messages: PromptMessage[]): ModelRequest => ({
  model: 'system',
  maxTokens: 512,
  tools: [],
  prompt: { system: [{ text: 'Be brief.', cache: false }], messages },
});

async function sentMessages(availability: NativeAvailability, messages: PromptMessage[]) {
  const bridge = fakeBridge(availability);
  await Effect.runPromise(Stream.runCollect(nativeModelClient(bridge).stream(requestOf(messages))));
  return bridge.generate.mock.calls[0]?.[0].messages;
}

describe('native on-device model images', () => {
  it('sends user images in order to a model that reads them, without reasoning or tools', async () => {
    expect(
      await sentMessages(READS_IMAGES, [
        {
          role: 'user',
          cache: false,
          parts: [
            { kind: 'toolResult', callId: 'call', body: 'noon', failed: false },
            { kind: 'image', media: 'image/png', data: 'AAAA' },
            { kind: 'text', text: 'Thanks' },
          ],
        },
        {
          role: 'assistant',
          cache: false,
          parts: [
            { kind: 'reasoning', text: 'Thinking it over' },
            { kind: 'text', text: 'Welcome.' },
          ],
        },
        {
          role: 'user',
          cache: false,
          parts: [
            { kind: 'image', media: 'image/jpeg', data: 'Rmlyc3Q=' },
            { kind: 'image', media: 'image/jpeg', data: 'U2Vjb25k' },
          ],
        },
      ])
    ).toEqual([
      { role: 'user', text: 'Thanks', images: [{ media: 'image/png', data: 'AAAA' }] },
      { role: 'assistant', text: 'Welcome.' },
      // An image-only question is still a question.
      {
        role: 'user',
        text: '',
        images: [
          { media: 'image/jpeg', data: 'Rmlyc3Q=' },
          { media: 'image/jpeg', data: 'U2Vjb25k' },
        ],
      },
    ]);
  });

  it('keeps the newest images within the model limit and marks the older ones', async () => {
    expect(
      await sentMessages({ ...READS_IMAGES, maxImages: 1 }, [
        {
          role: 'user',
          cache: false,
          parts: [
            { kind: 'image', media: 'image/jpeg', data: 'T2xk' },
            { kind: 'text', text: 'Before' },
          ],
        },
        { role: 'assistant', cache: false, parts: [{ kind: 'text', text: 'Seen.' }] },
        {
          role: 'user',
          cache: false,
          parts: [
            { kind: 'image', media: 'image/jpeg', data: 'TmV3' },
            { kind: 'text', text: 'And this?' },
          ],
        },
      ])
    ).toEqual([
      { role: 'user', text: `${IMAGE_NOT_SENT}\n\nBefore` },
      { role: 'assistant', text: 'Seen.' },
      { role: 'user', text: 'And this?', images: [{ media: 'image/jpeg', data: 'TmV3' }] },
    ]);
  });

  it('sends no image to a model that reads none', async () => {
    expect(
      await sentMessages({ ...READS_IMAGES, images: false }, [
        {
          role: 'user',
          cache: false,
          parts: [
            { kind: 'image', media: 'image/jpeg', data: 'TmV3' },
            { kind: 'text', text: 'And this?' },
          ],
        },
      ])
    ).toEqual([{ role: 'user', text: 'And this?' }]);
  });
});

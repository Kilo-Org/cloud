import { type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Stream } from 'effect';
import { vi } from 'vitest';

import {
  type NativeAvailability,
  type NativeModelBridge,
  nativeModelClient,
  type NativeModelEvent,
} from './native-model-client';

/**
 * A scripted native module and the request the native client tests send it.
 * Shared by the text and the tool tests beside this file.
 */
export const AVAILABLE: NativeAvailability = {
  status: 'available',
  modelId: 'apple-system-language-model',
  contextWindow: 4096,
  maxOutputTokens: 1000,
  systemInstructions: true,
  tokenCounting: true,
};

type GenerateRequest = Parameters<NativeModelBridge['generate']>[0];
type Emit = (event: NativeModelEvent) => void;
/** What the native module does during `generate`; throwing rejects the promise. */
export type Script = (request: GenerateRequest, emit: Emit) => void;

export function fakeBridge(
  script: Script,
  extra: Pick<NativeModelBridge, 'countTokens'> & { running?: Promise<unknown> } = {}
) {
  const listeners = new Set<(event: NativeModelEvent) => void>();
  const emit: Emit = event => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  const bridge = {
    availability: vi.fn<NativeModelBridge['availability']>().mockResolvedValue(AVAILABLE),
    generate: vi.fn(async (request: GenerateRequest) => {
      script(request, emit);
      await extra.running;
    }),
    cancel: vi.fn<NativeModelBridge['cancel']>().mockResolvedValue(undefined),
    resume: vi.fn<NonNullable<NativeModelBridge['resume']>>().mockResolvedValue(undefined),
    ...(extra.countTokens === undefined ? {} : { countTokens: extra.countTokens }),
    addListener: (_name: 'onModelEvent', listener: (event: NativeModelEvent) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
  } satisfies NativeModelBridge;
  return { bridge, emit, listeners };
}

export const request: ModelRequest = {
  model: 'system',
  maxTokens: 4096,
  tools: [
    {
      name: 'time',
      description: 'Current time',
      parameters: { type: 'object', properties: {} },
    },
  ],
  prompt: {
    system: [
      { text: 'Be brief.', cache: false },
      { text: 'Answer in English.', cache: true },
    ],
    messages: [
      { role: 'user', cache: false, parts: [{ kind: 'text', text: 'What is Kilo?' }] },
      {
        role: 'assistant',
        cache: false,
        parts: [
          { kind: 'reasoning', text: 'Thinking it over' },
          { kind: 'text', text: 'A coding agent.' },
          { kind: 'toolCall', callId: 'call', name: 'time', arguments: '{}' },
        ],
      },
      {
        role: 'user',
        cache: true,
        parts: [
          { kind: 'toolResult', callId: 'call', body: 'noon', failed: false },
          { kind: 'image', media: 'image/png', data: 'AAAA' },
          { kind: 'text', text: 'Thanks' },
        ],
      },
    ],
  },
};

export async function collect(
  bridge: NativeModelBridge,
  stream = nativeModelClient(bridge).stream(request)
) {
  const result = await Effect.runPromise(Effect.either(Stream.runCollect(stream)));
  return result;
}

/** Streams one delta, then a done carrying the given native usage. */
export const answerWith =
  (usage: Partial<Extract<NativeModelEvent, { kind: 'done' }>>): Script =>
  (native, emit) => {
    emit({ id: native.id, kind: 'delta', text: 'abcdefg' });
    emit({ id: native.id, kind: 'done', stop: 'end', usageSource: 'unavailable', ...usage });
  };

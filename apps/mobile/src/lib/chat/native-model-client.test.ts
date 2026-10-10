import { type ModelEvent, type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Either, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { backendFailureKey } from './backend-target';
import {
  type NativeAvailability,
  type NativeModelBridge,
  nativeModelClient,
  type NativeModelEvent,
} from './native-model-client';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

const AVAILABLE: NativeAvailability = {
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
type Script = (request: GenerateRequest, emit: Emit) => void;

function fakeBridge(
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

const request: ModelRequest = {
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

async function collect(
  bridge: NativeModelBridge,
  stream = nativeModelClient(bridge).stream(request)
) {
  const result = await Effect.runPromise(Effect.either(Stream.runCollect(stream)));
  return result;
}

/** Streams one delta, then a done carrying the given native usage. */
const answerWith =
  (usage: Partial<Extract<NativeModelEvent, { kind: 'done' }>>): Script =>
  (native, emit) => {
    emit({ id: native.id, kind: 'delta', text: 'abcdefg' });
    emit({ id: native.id, kind: 'done', stop: 'end', usageSource: 'unavailable', ...usage });
  };

async function events(bridge: NativeModelBridge): Promise<ModelEvent[]> {
  const result = await collect(bridge);
  if (Either.isLeft(result)) {
    throw new Error('Expected the answer to finish');
  }
  return [...result.right];
}

async function failureKey(bridge: NativeModelBridge): Promise<string> {
  const result = await collect(bridge);
  if (Either.isRight(result)) {
    throw new Error('Expected the answer to fail');
  }
  return backendFailureKey(result.left);
}

describe('native on-device model client', () => {
  it('sends text-only history without tools and streams one done', async () => {
    const { bridge } = fakeBridge((native, emit) => {
      emit({ id: native.id, kind: 'delta', text: 'Hel' });
      emit({ id: 'another-request', kind: 'delta', text: 'ignored' });
      emit({ id: native.id, kind: 'delta', text: 'lo' });
      emit({
        id: native.id,
        kind: 'done',
        stop: 'end',
        usageSource: 'reported',
        inputTokens: 40,
        outputTokens: 2,
      });
    });
    expect(await events(bridge)).toEqual([
      { kind: 'delta', text: 'Hel' },
      { kind: 'delta', text: 'lo' },
      {
        kind: 'done',
        stop: 'end',
        usage: { inputTokens: 40, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
    expect(bridge.generate).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      system: 'Be brief.\n\nAnswer in English.',
      messages: [
        { role: 'user', text: 'What is Kilo?' },
        { role: 'assistant', text: 'A coding agent.' },
        { role: 'user', text: 'Thanks' },
      ],
      maxTokens: 1000,
    });
  });

  it.each([
    ['unavailable', { ...AVAILABLE, status: 'unavailable', reason: 'apple_intelligence_disabled' }],
    ['downloadable', { ...AVAILABLE, status: 'downloadable' }],
  ] as const)('fails explicitly when the model is %s at send time', async (_label, answer) => {
    const { bridge } = fakeBridge(() => undefined);
    bridge.availability.mockResolvedValue(answer);
    expect(await failureKey(bridge)).toBe('modelChat.localModels.unavailable');
    expect(bridge.generate).not.toHaveBeenCalled();
  });

  it('fails explicitly when the availability check itself fails', async () => {
    const { bridge } = fakeBridge(() => undefined);
    bridge.availability.mockRejectedValue(new Error('native failure'));
    expect(await failureKey(bridge)).toBe('modelChat.localModels.unavailable');
    expect(bridge.generate).not.toHaveBeenCalled();
  });

  it('reports busy from a rejection that carries no event', async () => {
    const { bridge } = fakeBridge(() => {
      throw Object.assign(new Error('busy'), { code: 'busy' });
    });
    expect(await failureKey(bridge)).toBe('modelChat.localModels.busy');
  });

  it('reports busy from an error event', async () => {
    const { bridge } = fakeBridge((native, emit) => {
      emit({ id: native.id, kind: 'error', reason: 'busy' });
      throw new Error('busy');
    });
    expect(await failureKey(bridge)).toBe('modelChat.localModels.busy');
  });

  // Android rejects or errors with these stable codes; none of them routes elsewhere.
  it.each([
    ['model_download_required', 'modelChat.localModels.unavailable'],
    ['model_downloading', 'modelChat.localModels.unavailable'],
    ['model_unavailable', 'modelChat.localModels.unavailable'],
    ['unsupported_os', 'modelChat.localModels.unavailable'],
    ['aicore_incompatible', 'modelChat.localModels.unavailable'],
    ['system_update_required', 'modelChat.localModels.unavailable'],
    ['battery_quota_exceeded', 'modelChat.localModels.unavailable'],
    ['background_use_blocked', 'modelChat.localModels.background'],
    ['busy', 'modelChat.localModels.busy'],
    ['context_exceeded', 'modelChat.localModels.failed'],
    ['generation_failed', 'modelChat.localModels.failed'],
    ['released', 'modelChat.localModels.failed'],
  ])('maps the Android rejection %s to %s', async (code, key) => {
    const { bridge } = fakeBridge(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(await failureKey(bridge)).toBe(key);
    expect(bridge.generate).toHaveBeenCalledOnce();
  });

  it('shows the background copy when Android stops an answer, and Retry answers after returning', async () => {
    let inFront = false;
    const { bridge } = fakeBridge((native, emit) => {
      emit({ id: native.id, kind: 'delta', text: 'Partial' });
      emit(
        inFront
          ? { id: native.id, kind: 'done', stop: 'end', usageSource: 'counted', inputTokens: 9 }
          : { id: native.id, kind: 'error', reason: 'background_use_blocked' }
      );
    });
    expect(await failureKey(bridge)).toBe('modelChat.localModels.background');

    inFront = true;
    const retried = await events(bridge);
    expect(retried.at(-1)).toMatchObject({ kind: 'done', stop: 'end' });
    expect(bridge.generate).toHaveBeenCalledTimes(2);
  });

  it('turns a failure after streaming began into a stream error with fixed copy', async () => {
    const { bridge } = fakeBridge((native, emit) => {
      emit({ id: native.id, kind: 'delta', text: 'Partial' });
      emit({ id: native.id, kind: 'error', reason: 'guardrail_violation' });
    });
    const result = await collect(bridge);
    expect(Either.isLeft(result) && result.left.reason).toBe('stream');
    expect(Either.isLeft(result) && backendFailureKey(result.left)).toBe(
      'modelChat.localModels.failed'
    );
  });

  it('cancels the native request when the stream is interrupted and emits no done', async () => {
    const running = Promise.withResolvers<undefined>();
    const { bridge, emit, listeners } = fakeBridge(
      (native, send) => {
        send({ id: native.id, kind: 'delta', text: 'First' });
      },
      { running: running.promise }
    );
    const taken = await collect(bridge, Stream.take(nativeModelClient(bridge).stream(request), 1));
    const id = bridge.generate.mock.calls[0]?.[0].id ?? '';
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith(id);
    expect(listeners.size).toBe(0);
    // A late terminal event from the cancelled request reaches nothing.
    emit({ id, kind: 'done', stop: 'end', usageSource: 'unavailable' });
    running.resolve(undefined);
    expect(Either.isRight(taken) && [...taken.right]).toEqual([{ kind: 'delta', text: 'First' }]);
  });

  it('prefers native usage, then the provider token count, then an estimate', async () => {
    const usageOf = async (bridge: NativeModelBridge) => {
      const done = await events(bridge);
      const last = done.at(-1);
      return last?.kind === 'done' ? last.usage : undefined;
    };
    const countTokens = vi
      .fn<NonNullable<NativeModelBridge['countTokens']>>()
      .mockResolvedValue(77);
    const counted = fakeBridge(
      answerWith({ usageSource: 'counted', inputTokens: 50, outputTokens: 4 }),
      { countTokens }
    );
    expect(await usageOf(counted.bridge)).toMatchObject({ inputTokens: 50, outputTokens: 4 });
    expect(countTokens).not.toHaveBeenCalled();

    const counter = fakeBridge(answerWith({}), { countTokens });
    // Output has no provider count here, so it uses the estimate: ceil(7 / 3).
    expect(await usageOf(counter.bridge)).toMatchObject({ inputTokens: 77, outputTokens: 3 });

    const failingCounter = fakeBridge(answerWith({}), {
      countTokens: vi
        .fn<NonNullable<NativeModelBridge['countTokens']>>()
        .mockRejectedValue(new Error('token_count_unavailable')),
    });
    const promptChars =
      'Be brief.\n\nAnswer in English.'.length +
      'What is Kilo?'.length +
      'A coding agent.'.length +
      'Thanks'.length;
    const estimate = { inputTokens: Math.ceil(promptChars / 3), outputTokens: 3 };
    expect(await usageOf(failingCounter.bridge)).toMatchObject(estimate);

    const noCounter = fakeBridge(answerWith({}), { countTokens });
    noCounter.bridge.availability.mockResolvedValue({ ...AVAILABLE, tokenCounting: false });
    expect(await usageOf(noCounter.bridge)).toMatchObject(estimate);
    expect(countTokens).toHaveBeenCalledOnce();
  });

  it('fails the answer when a bridge resolves without a terminal event', async () => {
    const { bridge } = fakeBridge((native, emit) => {
      emit({ id: native.id, kind: 'delta', text: 'Half' });
      // No done and no error: the promise resolves anyway.
    });
    const result = await collect(bridge);
    expect(Either.isLeft(result) && result.left.reason).toBe('stream');
    expect(Either.isLeft(result) && backendFailureKey(result.left)).toBe(
      'modelChat.localModels.failed'
    );
  });
});

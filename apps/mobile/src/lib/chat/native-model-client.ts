import {
  type ModelClientService,
  type ModelError,
  type ModelEvent,
  type ModelRequest,
  type ModelUsage,
  type StopReason,
} from '@kilocode/harness-sdk';
import { Cause, Effect, Queue, Stream } from 'effect';
import { z } from 'zod';

import { nativeModelFailure } from './native-model-error';
import { cancelNative, openProvider, type Provider } from './native-round-slot';
import { estimatedTokens, inputTokensOf } from './native-model-usage';
import {
  nativeRequest,
  type NativeRequest,
  type NativeToolCall,
  type NativeToolResult,
  resultsOf,
} from './native-request';

export { IMAGE_NOT_SENT } from './native-request';
export { releaseNativeModelRound } from './native-round-slot';

/** What an on-device provider says about itself. Reasons are stable codes, never raw text. */
export type NativeAvailability = {
  readonly status: 'available' | 'unavailable' | 'downloadable' | 'downloading';
  readonly reason?: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly systemInstructions: boolean;
  readonly tokenCounting?: boolean;
  /** The model reads image parts. Absent means it reads none. */
  readonly images?: boolean;
  /** The most images one request can carry. Absent means no fixed limit. */
  readonly maxImages?: number;
  /** True when the module runs the harness tool loop. Absent means text only. */
  readonly tools?: boolean;
};

export type NativeModelEvent =
  | { readonly id: string; readonly kind: 'delta'; readonly text: string }
  /** The model asked for tools. The generation waits until `resume` answers every call. */
  | { readonly id: string; readonly kind: 'toolCalls'; readonly calls: readonly NativeToolCall[] }
  | {
      readonly id: string;
      readonly kind: 'done';
      readonly stop: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly usageSource: 'reported' | 'counted' | 'unavailable';
    }
  | { readonly id: string; readonly kind: 'error'; readonly reason: string };

/** The JavaScript shape shared by the Apple and Android inference modules. */
export type NativeModelBridge = {
  readonly availability: () => Promise<NativeAvailability>;
  readonly generate: (request: NativeRequest) => Promise<void>;
  readonly cancel: (id: string) => Promise<void>;
  readonly countTokens?: (request: NativeRequest) => Promise<number>;
  /** Answers the calls a waiting generation asked for. That generation then streams on. */
  readonly resume?: (id: string, results: readonly NativeToolResult[]) => Promise<void>;
  readonly addListener: (
    eventName: 'onModelEvent',
    listener: (event: NativeModelEvent) => void
  ) => { remove: () => void };
};

/** A native promise rejection carries its stable reason as an Expo error code. */
const codedRejection = z.object({ code: z.string() });

const TOOLS_CLOSED =
  'No tool can run for the rest of this answer. Answer now with the results you already have.';

const TRANSIENT_REASON = 'token_generation_failed';
let sequence = 0;

function nextRequestId(): string {
  sequence += 1;
  return `quick-chat-${sequence}`;
}

function answer(
  provider: Provider,
  availability: NativeAvailability,
  request: ModelRequest
): Stream.Stream<ModelEvent, ModelError> {
  return Stream.callback<ModelEvent, ModelError>(queue => {
    const bridge = provider.bridge;
    const tools = availability.tools === true && bridge.resume !== undefined;
    const offersTools = tools && request.tools !== undefined && request.tools.length > 0;
    const native = nativeRequest(request, {
      id: nextRequestId(),
      ceiling: availability.maxOutputTokens,
      tools,
      images: availability.images === true,
      maxImages: availability.maxImages,
    });
    const results = tools ? resultsOf(request) : undefined;
    const held = provider.loop.kind === 'waiting' ? provider.loop.round : undefined;
    // The results answer the waiting generation only when they answer every call it made.
    const resumption =
      held !== undefined &&
      results?.length === held.calls.length &&
      results.every(result => held.calls.includes(result.callId))
        ? { id: held.id, results }
        : undefined;
    /* The exchange that asked is the only one that may drop its own round. The
       owner asks again with no results when its turn was abandoned under the
       tools — Stop, the chat closed, a sign-out — and that round can never be
       answered, so it is cancelled instead of holding the bridge busy forever. */
    const abandoned =
      held !== undefined &&
      resumption === undefined &&
      results === undefined &&
      held.owner !== undefined &&
      held.owner === request.cacheKey;
    // Another chat's generation is between two rounds: it is live, and this
    // request has nothing that answers it. Refuse rather than cancel it or
    // steal its slot. The slot is untouched for the round that owns it.
    if (held !== undefined && resumption === undefined && !abandoned) {
      return Effect.fail(nativeModelFailure('busy', false));
    }
    // The round this request answers — or replaces — starts here, so the bridge
    // is free again until that round asks for tools itself.
    if (resumption !== undefined || abandoned) {
      provider.loop = { kind: 'free' };
    }
    let id = resumption?.id ?? native.id;
    const hasPreviousText = resumption !== undefined && held?.hasText === true;
    // `running` is the only state that owns a live native inference. `waiting`
    // hands it to the next round, which answers its tool calls. `retrying`
    // waits for the failed attempt to settle before a fresh one starts.
    let state: 'running' | 'retrying' | 'finishing' | 'waiting' | 'over' = 'running';
    let output = '';
    // A resumed generation already ran its tool calls, and a new one cannot continue from them.
    let retries = resumption === undefined ? 1 : 0;
    const fail = (reason: string | undefined) => {
      state = 'over';
      Queue.failCauseUnsafe(
        queue,
        Cause.fail(nativeModelFailure(reason, hasPreviousText || output !== ''))
      );
    };
    const failOrRetry = (reason: string | undefined) => {
      if (
        (reason === TRANSIENT_REASON || reason === 'empty_response') &&
        output === '' &&
        retries > 0
      ) {
        retries -= 1;
        state = 'retrying';
      } else {
        fail(reason);
      }
    };
    const finish = async (done: Extract<NativeModelEvent, { kind: 'done' }>) => {
      if (!hasPreviousText && output.trim() === '') {
        fail('empty_response');
        return;
      }
      state = 'finishing';
      const counts = done.usageSource === 'unavailable' ? undefined : done;
      const usage: ModelUsage = {
        inputTokens: counts?.inputTokens ?? (await inputTokensOf(bridge, availability, native)),
        outputTokens: counts?.outputTokens ?? estimatedTokens(output),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      // Apple reports `unknown` when no public signal says why the stream ended.
      const stop: StopReason =
        done.stop === 'end' || done.stop === 'maxTokens' || done.stop === 'refusal'
          ? done.stop
          : 'unknown';
      Queue.offerUnsafe(queue, { kind: 'done', usage, stop });
      Queue.endUnsafe(queue);
    };
    // The round ends here; the native generation waits for the next round's results.
    const pause = async (calls: readonly NativeToolCall[]) => {
      state = 'waiting';
      // Published before the stream ends, so the results round finds it.
      provider.loop = {
        kind: 'waiting',
        round: {
          id,
          owner: request.cacheKey,
          calls: calls.map(call => call.id),
          hasText: hasPreviousText || output.trim() !== '',
        },
      };
      output += calls.map(call => call.name + call.arguments).join('');
      Queue.offerAllUnsafe(
        queue,
        calls.map((call): ModelEvent => ({
          kind: 'toolCall',
          call: { id: call.id, name: call.name, arguments: call.arguments },
        }))
      );
      const usage: ModelUsage = {
        inputTokens: await inputTokensOf(bridge, availability, native),
        outputTokens: estimatedTokens(output),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      Queue.offerUnsafe(queue, { kind: 'done', usage, stop: 'tools' });
      Queue.endUnsafe(queue);
    };
    // The harness ends a turn with a round that offers no tools, so that the
    // model answers from the results it has. A resumed Foundation Models
    // generation keeps the tools its session opened with, and a call it makes
    // now would end the turn with no answer. The call gets a result that says
    // so, and the same generation continues to its answer. A model that calls
    // again after that would loop until the window is full, so it fails.
    let refused = false;
    const refuse = async (calls: readonly NativeToolCall[]) => {
      if (refused) {
        fail('tools_refused');
        await cancelNative(bridge, id);
        return;
      }
      refused = true;
      try {
        await bridge.resume?.(
          id,
          calls.map(call => ({ callId: call.id, body: TOOLS_CLOSED }))
        );
      } catch (error) {
        if (state === 'running') {
          const coded = codedRejection.safeParse(error);
          fail(coded.success ? coded.data.code : undefined);
        }
      }
    };
    const subscription = bridge.addListener('onModelEvent', event => {
      if (event.id !== id || state !== 'running') {
        return;
      }
      if (event.kind === 'delta') {
        output += event.text;
        Queue.offerUnsafe(queue, { kind: 'delta', text: event.text });
      } else if (event.kind === 'toolCalls') {
        void (offersTools ? pause(event.calls) : refuse(event.calls));
      } else if (event.kind === 'error') {
        failOrRetry(event.reason);
      } else {
        void finish(event);
      }
    });
    const rejected = (error: unknown) => {
      if (state === 'running') {
        const coded = codedRejection.safeParse(error);
        failOrRetry(coded.success ? coded.data.code : undefined);
      }
    };
    const generate = async () => {
      try {
        await bridge.generate({ ...native, id });
        // A bridge resolves only after it emitted its terminal event. A resolve
        // with none is a bridge defect: failing is what releases the caller
        // instead of leaving the answer streaming forever.
        if (state === 'running') {
          fail('missing_terminal_event');
        }
      } catch (error) {
        rejected(error);
      }
    };
    const run = async () => {
      // Only the round this owner abandoned, never another chat's generation.
      if (abandoned) {
        await cancelNative(bridge, held.id);
      }
      if (resumption !== undefined) {
        await bridge.resume?.(resumption.id, resumption.results).catch(rejected);
        return;
      }
      // Results with no generation waiting for them: the round they answer is gone.
      if (results !== undefined) {
        fail(undefined);
        return;
      }
      await generate();
      // The failed attempt has settled, so the native module is free for a new one.
      if (state === 'retrying') {
        state = 'running';
        id = nextRequestId();
        await generate();
      }
    };
    return Effect.andThen(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          subscription.remove();
          if (state === 'running' || state === 'retrying') {
            // Interrupted mid-answer: stop the native task. Its late events are ignored.
            state = 'over';
            void cancelNative(bridge, id);
          }
        })
      ),
      () => Effect.sync(() => void run())
    );
  });
}

/**
 * Inference over a native on-device model. The harness still owns the
 * conversation: every request carries the full rendered history, and nothing
 * falls back to another model when this one is unavailable or busy.
 *
 * A model that runs tools keeps one generation open across a tool round. The
 * harness runs the calls, and its next request carries their results, which
 * resume that generation instead of starting a new one.
 */
export function nativeModelClient(bridge: NativeModelBridge): ModelClientService {
  const provider: Provider = openProvider(bridge);
  return {
    stream: request =>
      Stream.unwrap(
        Effect.tryPromise({
          try: async () => {
            const availability = await bridge.availability();
            return availability;
          },
          catch: () => nativeModelFailure('model_unavailable', false),
        }).pipe(
          Effect.filterOrFail(
            availability => availability.status === 'available',
            () => nativeModelFailure('model_unavailable', false)
          ),
          Effect.map(availability => answer(provider, availability, request))
        )
      ),
  };
}

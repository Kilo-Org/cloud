import {
  type ModelClientService,
  ModelError,
  type ModelEvent,
  type ModelRequest,
  type ModelUsage,
  type StopReason,
} from '@kilocode/harness-sdk';
import { Chunk, Effect, Stream } from 'effect';
import { z } from 'zod';

import { LocalModelError, type LocalModelProblem } from './local-model-error';
import {
  nativeRequest,
  type NativeRequest,
  type NativeToolCall,
  type NativeToolResult,
  resultsOf,
} from './native-request';

/** What an on-device provider says about itself. Reasons are stable codes, never raw text. */
export type NativeAvailability = {
  readonly status: 'available' | 'unavailable' | 'downloadable' | 'downloading';
  readonly reason?: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly systemInstructions: boolean;
  readonly tokenCounting?: boolean;
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

/** A generation that asked for tools and waits, between two harness rounds, for their results. */
type ToolLoop = { waiting?: { readonly id: string; readonly calls: readonly string[] } };

/** One native module and the tool round it may hold open. */
type Provider = { readonly bridge: NativeModelBridge; readonly loop: ToolLoop };

/** Reasons that mean the model cannot run here now, as opposed to a failed answer. */
const UNAVAILABLE_REASONS = new Set([
  'unsupported_os',
  'device_not_eligible',
  'apple_intelligence_disabled',
  'model_not_ready',
  'model_unavailable',
  // Android AICore: the model still needs, or is in, its system download.
  'model_download_required',
  'model_downloading',
  // Android AICore: the system service must be updated first.
  'aicore_incompatible',
  'system_update_required',
  // Android AICore: the per-app battery quota for inference is spent.
  'battery_quota_exceeded',
]);

/** A native promise rejection carries its stable reason as an Expo error code. */
const codedRejection = z.object({ code: z.string() });

let sequence = 0;

function problemOf(reason: string | undefined): LocalModelProblem {
  if (reason === 'busy') {
    return 'busy';
  }
  // Android runs the model only while the app is in front; Retry works after returning.
  if (reason === 'background_use_blocked') {
    return 'background';
  }
  return reason !== undefined && UNAVAILABLE_REASONS.has(reason) ? 'unavailable' : 'failed';
}

/** Fixed copy only: the native reason picks the key and is not shown or logged. */
function failure(problem: LocalModelProblem, started: boolean): ModelError {
  return new ModelError({
    reason: started ? 'stream' : 'unsupported',
    cause: new LocalModelError(problem),
  });
}

/**
 * A deliberately high guess of about three characters per token. It is not a
 * count: it exists so a session on a small on-device window still compacts
 * when the provider reports no usage and cannot count tokens.
 */
function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Input usage without native counts: the provider's token counter, else the estimate. */
async function inputTokensOf(
  bridge: NativeModelBridge,
  availability: NativeAvailability,
  request: NativeRequest
): Promise<number> {
  if (bridge.countTokens !== undefined && availability.tokenCounting !== false) {
    try {
      return await bridge.countTokens(request);
    } catch {
      // The count is optional; the estimate below keeps compaction working.
    }
  }
  const texts = request.messages.map(message =>
    message.role === 'toolCalls'
      ? message.calls.map(call => call.name + call.arguments).join('')
      : message.text
  );
  return estimatedTokens(request.system + texts.join(''));
}

function answer(
  { bridge, loop }: Provider,
  availability: NativeAvailability,
  request: ModelRequest
): Stream.Stream<ModelEvent, ModelError> {
  return Stream.async<ModelEvent, ModelError>(emit => {
    const tools = availability.tools === true && bridge.resume !== undefined;
    sequence += 1;
    const native = nativeRequest(request, {
      id: `quick-chat-${sequence}`,
      ceiling: availability.maxOutputTokens,
      tools,
    });
    const results = tools ? resultsOf(request) : undefined;
    const { waiting } = loop;
    loop.waiting = undefined;
    // The results answer the waiting generation only when they answer every call it made.
    const resumption =
      waiting !== undefined &&
      results?.length === waiting.calls.length &&
      results.every(result => waiting.calls.includes(result.callId))
        ? { id: waiting.id, results }
        : undefined;
    const id = resumption?.id ?? native.id;
    // `running` is the only state that owns a live native inference. `waiting`
    // hands it to the next round, which answers its tool calls.
    let state: 'running' | 'finishing' | 'waiting' | 'over' = 'running';
    let output = '';
    const fail = (reason: string | undefined) => {
      state = 'over';
      void emit.fail(failure(problemOf(reason), output !== ''));
    };
    const finish = async (done: Extract<NativeModelEvent, { kind: 'done' }>) => {
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
      await emit.single({ kind: 'done', usage, stop });
      await emit.end();
    };
    // The round ends here; the native generation waits for the next round's results.
    const pause = async (calls: readonly NativeToolCall[]) => {
      state = 'waiting';
      loop.waiting = { id, calls: calls.map(call => call.id) };
      output += calls.map(call => call.name + call.arguments).join('');
      await emit.chunk(
        Chunk.fromIterable(
          calls.map(
            (call): ModelEvent => ({
              kind: 'toolCall',
              call: { id: call.id, name: call.name, arguments: call.arguments },
            })
          )
        )
      );
      const usage: ModelUsage = {
        inputTokens: await inputTokensOf(bridge, availability, native),
        outputTokens: estimatedTokens(output),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      await emit.single({ kind: 'done', usage, stop: 'tools' });
      await emit.end();
    };
    const subscription = bridge.addListener('onModelEvent', event => {
      if (event.id !== id || state !== 'running') {
        return;
      }
      if (event.kind === 'delta') {
        output += event.text;
        void emit.single({ kind: 'delta', text: event.text });
      } else if (event.kind === 'toolCalls') {
        void pause(event.calls);
      } else if (event.kind === 'error') {
        fail(event.reason);
      } else {
        void finish(event);
      }
    });
    const stopNative = async (stopped: string) => {
      try {
        await bridge.cancel(stopped);
      } catch {
        // The native request already ended; there is nothing left to stop.
      }
    };
    const run = async () => {
      try {
        if (resumption !== undefined) {
          await bridge.resume?.(resumption.id, resumption.results);
          return;
        }
        // A waiting generation this request does not answer can never continue.
        if (waiting !== undefined) {
          await stopNative(waiting.id);
        }
        // Results with no generation waiting for them: the round they answer is gone.
        if (results !== undefined) {
          fail(undefined);
          return;
        }
        await bridge.generate(native);
      } catch (error) {
        // A rejection with no terminal event (Android reports busy this way).
        if (state === 'running') {
          const coded = codedRejection.safeParse(error);
          fail(coded.success ? coded.data.code : undefined);
        }
      }
    };
    void run();
    return Effect.sync(() => {
      subscription.remove();
      if (state === 'running') {
        // Interrupted mid-answer: stop the native task. Its late events are ignored.
        state = 'over';
        void stopNative(id);
      }
    });
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
  const provider: Provider = { bridge, loop: {} };
  return {
    stream: request =>
      Stream.unwrap(
        Effect.tryPromise({
          try: async () => {
            const availability = await bridge.availability();
            return availability;
          },
          catch: () => failure('unavailable', false),
        }).pipe(
          Effect.filterOrFail(
            availability => availability.status === 'available',
            () => failure('unavailable', false)
          ),
          Effect.map(availability => answer(provider, availability, request))
        )
      ),
  };
}

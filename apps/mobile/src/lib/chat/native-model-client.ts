import {
  type ModelClientService,
  ModelError,
  type ModelEvent,
  type ModelRequest,
  type ModelUsage,
  type StopReason,
} from '@kilocode/harness-sdk';
import { Effect, Stream } from 'effect';
import { z } from 'zod';

import { LocalModelError, type LocalModelProblem } from './local-model-error';

/** What an on-device provider says about itself. Reasons are stable codes, never raw text. */
export type NativeAvailability = {
  readonly status: 'available' | 'unavailable' | 'downloadable' | 'downloading';
  readonly reason?: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly systemInstructions: boolean;
  readonly tokenCounting?: boolean;
};

type NativeMessage = { readonly role: 'user' | 'assistant'; readonly text: string };

type NativeRequest = {
  readonly id: string;
  readonly system: string;
  readonly messages: readonly NativeMessage[];
  readonly maxTokens: number;
};

export type NativeModelEvent =
  | { readonly id: string; readonly kind: 'delta'; readonly text: string }
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
  readonly addListener: (
    eventName: 'onModelEvent',
    listener: (event: NativeModelEvent) => void
  ) => { remove: () => void };
};

/** Reasons that mean the model cannot run here now, as opposed to a failed answer. */
const UNAVAILABLE_REASONS = new Set([
  'unsupported_os',
  'device_not_eligible',
  'apple_intelligence_disabled',
  'model_not_ready',
  'model_unavailable',
]);

/** A native promise rejection carries its stable reason as an Expo error code. */
const codedRejection = z.object({ code: z.string() });

let sequence = 0;

function problemOf(reason: string | undefined): LocalModelProblem {
  if (reason === 'busy') {
    return 'busy';
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

/** Text only: reasoning, images, and tool parts never reach a system model. */
function nativeRequest(request: ModelRequest, id: string, ceiling: number): NativeRequest {
  const messages: NativeMessage[] = [];
  for (const message of request.prompt.messages) {
    const text = message.parts
      .flatMap(part => (part.kind === 'text' ? [part.text] : []))
      .join('\n\n');
    if (text !== '') {
      messages.push({ role: message.role, text });
    }
  }
  return {
    id,
    system: request.prompt.system.map(block => block.text).join('\n\n'),
    messages,
    maxTokens: ceiling > 0 ? Math.min(request.maxTokens, ceiling) : request.maxTokens,
  };
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
  return estimatedTokens(request.system + request.messages.map(message => message.text).join(''));
}

function answer(
  bridge: NativeModelBridge,
  availability: NativeAvailability,
  request: ModelRequest
): Stream.Stream<ModelEvent, ModelError> {
  return Stream.async<ModelEvent, ModelError>(emit => {
    sequence += 1;
    const native = nativeRequest(request, `quick-chat-${sequence}`, availability.maxOutputTokens);
    // `running` is the only state that owns a live native inference.
    let state: 'running' | 'finishing' | 'over' = 'running';
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
    const subscription = bridge.addListener('onModelEvent', event => {
      if (event.id !== native.id || state !== 'running') {
        return;
      }
      if (event.kind === 'delta') {
        output += event.text;
        void emit.single({ kind: 'delta', text: event.text });
      } else if (event.kind === 'error') {
        fail(event.reason);
      } else {
        void finish(event);
      }
    });
    const run = async () => {
      try {
        await bridge.generate(native);
      } catch (error) {
        // A rejection with no terminal event (Android reports busy this way).
        if (state === 'running') {
          const coded = codedRejection.safeParse(error);
          fail(coded.success ? coded.data.code : undefined);
        }
      }
    };
    const stopNative = async () => {
      try {
        await bridge.cancel(native.id);
      } catch {
        // The native request already ended; there is nothing left to stop.
      }
    };
    void run();
    return Effect.sync(() => {
      subscription.remove();
      if (state === 'running') {
        // Interrupted mid-answer: stop the native task. Its late events are ignored.
        state = 'over';
        void stopNative();
      }
    });
  });
}

/**
 * Inference over a native on-device model. The harness still owns the
 * conversation: every request carries the full rendered history, and nothing
 * falls back to another model when this one is unavailable or busy.
 */
export function nativeModelClient(bridge: NativeModelBridge): ModelClientService {
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
          Effect.map(availability => answer(bridge, availability, request))
        )
      ),
  };
}

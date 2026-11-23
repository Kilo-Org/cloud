/* eslint-disable max-lines -- the teardown chain, the answer's ownership of it, and the release cause that stops an answer are one closure: the one-context invariant cannot be read across two files */
import {
  type ModelClientService,
  ModelError,
  type ModelEvent,
  type ModelRequest,
} from '@kilocode/harness-sdk';
import { Cause, Effect, Queue, Stream } from 'effect';
import { type ContextParams, type LlamaContext, type TokenData } from 'llama.rn';

import { LocalModelError, type LocalModelProblem } from './local-model-error';
import { attempt, type GgufModelFile, settled } from './gguf-records';
import { answerOf, type CompletionResult, paramsOf, readCompletion, stopOf } from './gguf-template';

/** The part of a llama.rn context this client drives. */
export type GgufContext = Pick<
  LlamaContext,
  'model' | 'completion' | 'stopCompletion' | 'release' | 'initMultimodal' | 'getMultimodalSupport'
>;

export type GgufRuntime = {
  readonly init: (params: ContextParams) => Promise<GgufContext>;
  /** Whether the vision projector runs on the GPU. */
  readonly gpu: boolean;
};

/**
 * What loading a projector said about the model. `refused` is llama.cpp failing
 * to load the projector at all, which says nothing about the bytes: the device
 * can be short of memory or its GPU stack can fail, so the read runs again.
 * `noVision` is a projector that loaded and reported no image support, which is
 * a property of these bytes and cannot change between reads.
 */
export type ProjectorLoad = 'vision' | 'noVision' | 'refused';

/**
 * Loads a projector into an open context, and reports which of the two
 * verdicts llama.cpp gave; the projector's own release runs with the
 * context's.
 */
export async function loadProjector(
  context: Pick<GgufContext, 'initMultimodal' | 'getMultimodalSupport'>,
  projector: string,
  gpu: boolean
): Promise<ProjectorLoad> {
  if (!(await context.initMultimodal({ path: projector, use_gpu: gpu }))) {
    return 'refused';
  }
  const support = await context.getMultimodalSupport();
  return support.vision ? 'vision' : 'noVision';
}

/**
 * Whether a model's projector reads images, as verification needs it. A refused
 * load throws, so the caller treats it as a refused read rather than the
 * deterministic verdict that removes the model.
 */
export async function projectorReadsImages(
  context: Pick<GgufContext, 'initMultimodal' | 'getMultimodalSupport'>,
  projector: string,
  gpu: boolean
): Promise<boolean> {
  const load = await loadProjector(context, projector, gpu);
  if (load === 'refused') {
    throw new Error('projector');
  }
  return load === 'vision';
}

/** Fixed copy only: llama.cpp errors are never shown or logged. */
function failure(problem: LocalModelProblem, started: boolean): ModelError {
  return new ModelError({
    reason: started ? 'stream' : 'unsupported',
    cause: new LocalModelError(problem),
  });
}

/**
 * How long a load waits for a teardown. A native release that never settles
 * would otherwise leave every later send spinning with no failure row, while
 * the stalled teardown stays pending so no second context opens beside it.
 */
export const RELEASE_WAIT_MS = 30_000;

/**
 * Waits for `teardown`, and reports whether `RELEASE_WAIT_MS` passed without
 * it: the promise itself is left running, since a context may still be freeing.
 */
async function waitForTeardown(teardown: Promise<void>): Promise<'settled' | 'stalled'> {
  const stalled = Symbol('teardown stalled');
  const { promise, resolve } = Promise.withResolvers<symbol>();
  const timer = setTimeout(() => {
    resolve(stalled);
  }, RELEASE_WAIT_MS);
  try {
    return (await Promise.race([teardown, promise])) === stalled ? 'stalled' : 'settled';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a release ran. The app leaving the foreground is not the model failing, so
 * the answer it stops carries this cause instead of the generic failure copy.
 */
export type GgufReleaseCause = 'background';

export type GgufModelClient = {
  readonly client: ModelClientService;
  /**
   * Stops any answer and frees the loaded context. With a file id, only when
   * that file is the one loaded, so deleting another model keeps this one.
   *
   * A cause names what the answer in flight is being stopped for: an answer
   * stopped by the background ends as that, not as a model failure. It is
   * consumed once, by the answer running when the release starts, and a release
   * with no cause - a delete, a model switch - says nothing about an answer that
   * is not interrupted by it.
   */
  readonly release: (fileId?: string, cause?: GgufReleaseCause) => Promise<void>;
};

/**
 * Inference over downloaded GGUF models with one llama.rn context at a time.
 * The context loads on the first request for its model, and switching models
 * releases the previous one first. One answer runs at a time; a request while
 * another runs fails as busy rather than queueing behind it.
 */
export function ggufModelClient({
  runtime,
  fileOf,
}: {
  readonly runtime: GgufRuntime;
  readonly fileOf: (fileId: string) => GgufModelFile | undefined;
}): GgufModelClient {
  let loaded: { readonly fileId: string; readonly context: Promise<GgufContext> } | undefined =
    undefined;
  let inflight: Promise<unknown> | undefined = undefined;
  /**
   * The teardown under way. Nothing opens a context until it settles, so two
   * multi-gigabyte models are never resident at once: the entry leaves `loaded`
   * first, and every caller that would open one waits here.
   */
  let freeing: Promise<void> = Promise.resolve();
  /**
   * The teardown whose own wait timed out, while it is still pending. Every send
   * would otherwise await it and pay the whole wait again before reporting
   * `unavailable`. The number is the teardown's, so a chain that settles late
   * clears only its own record and never a newer stall.
   */
  let freeingGeneration = 0;
  let stalledGeneration: number | undefined = undefined;
  let busy = false;
  let sequence = 0;
  /**
   * Ends the answer the client cannot interrupt. A stop that throws never
   * reaches its completion, so that promise can stay pending forever: waiting
   * for it would wedge the teardown, and leaving it owned would keep the client
   * busy for the rest of the session.
   */
  let abandon: (() => void) | undefined = undefined;
  /**
   * Why the release under way ran, for the answer it is stopping. It belongs to
   * the turn it interrupts: the answer that reads it clears it, so a later
   * answer is never ended with a cause meant for an earlier one. A release that
   * runs with no answer in flight names nothing here, since no answer can be
   * stopped by it.
   */
  let noteRelease: ((cause: GgufReleaseCause) => void) | undefined = undefined;

  const free = async (
    previous: Promise<void>,
    current: { readonly context: Promise<GgufContext> },
    generation: number
  ) => {
    // Every await is a `settled`/`attempt`, so nothing here rejects: the chain
    // every later load waits on never stays rejected.
    try {
      await settled(previous);
      const context = await settled(current.context);
      if (!context.ok) {
        return;
      }
      const running = inflight;
      if (running !== undefined) {
        // A freed handle throws where the method is called, so the stop is a
        // thunk. It must not skip the release below, which frees the context the
        // one-context invariant depends on.
        const stopped = await attempt(() => context.value.stopCompletion());
        // A stop that never ran cannot interrupt the answer: its completion may
        // never settle, so waiting for it would hold the chain every later load
        // waits on, and the answer has to give up its ownership of the client.
        // The release below still frees the weights.
        if (stopped.ok) {
          await settled(running);
        } else {
          // llama.rn 0.12.9: a throw here means the id is already gone from
          // `g_llamaContexts`, and `llamaReleaseContext` waits on
          // `TaskManager::waitForContext` before deleting, so freeing now cannot pull
          // the weights out from under a running native completion.
          abandon?.();
        }
      }
      await attempt(() => context.value.release());
    } finally {
      // This chain has done its work, so its stall is over. Clearing inside the
      // body runs before the promise settles, so the send that settlement wakes
      // waits on a finished chain instead of a stale record.
      if (stalledGeneration === generation) {
        stalledGeneration = undefined;
      }
    }
  };

  const release = (fileId?: string, cause?: GgufReleaseCause): Promise<void> => {
    // The cause belongs to the answer this release stops, so it is handed over
    // before the teardown below can settle that answer. A release that finds no
    // answer in flight has nothing to label.
    if (cause !== undefined) {
      noteRelease?.(cause);
    }
    const current = loaded;
    if (current === undefined || (fileId !== undefined && current.fileId !== fileId)) {
      // Nothing of this model is loaded, but a release the background listener
      // started may still be freeing one, and the caller waits for it.
      return freeing;
    }
    loaded = undefined;
    freeingGeneration += 1;
    freeing = free(freeing, current, freeingGeneration);
    return freeing;
  };

  /** A vision model whose projector does not load is not the model that was verified. */
  const open = async (file: GgufModelFile): Promise<GgufContext> => {
    const context = await runtime.init({
      model: file.path,
      n_ctx: file.contextWindow,
      n_parallel: 1,
      // llama.rn requires this for media: a shift would move the image tokens.
      ...(file.projector === undefined ? {} : { ctx_shift: false }),
    });
    if (file.projector === undefined) {
      return context;
    }
    // Both a refused load and a projector that reads no images mean this context
    // cannot do what the record promised, so it is freed and the answer fails.
    const vision = await settled(loadProjector(context, file.projector, runtime.gpu));
    if (!vision.ok || vision.value !== 'vision') {
      // A freed handle throws where the method is called, before a promise exists.
      await attempt(() => context.release());
      throw new Error('projector');
    }
    return context;
  };

  const load = async (fileId: string, file: GgufModelFile): Promise<GgufContext> => {
    if (loaded?.fileId === fileId) {
      return loaded.context;
    }
    const teardown = release();
    const generation = freeingGeneration;
    // This teardown already timed out and is still pending, so it cannot settle
    // while this send runs: refusing at once is the same `unavailable` answer
    // without paying the whole wait again. Nothing opens beside it either way.
    if (stalledGeneration === generation) {
      throw new Error('teardown stalled');
    }
    // A teardown that never settles rejects this load rather than waiting
    // forever, which takes the caller's `unavailable` path; the teardown itself
    // stays pending, so it still keeps the next context from opening beside it.
    if ((await waitForTeardown(teardown)) === 'stalled') {
      stalledGeneration = generation;
      throw new Error('teardown stalled');
    }
    const context = open(file);
    loaded = { fileId, context };
    return context;
  };

  const answer = (request: ModelRequest, file: GgufModelFile) =>
    Stream.callback<ModelEvent, ModelError>(queue => {
      sequence += 1;
      const id = `gguf-${sequence}`;
      let state: 'running' | 'over' = 'running';
      let streamed = '';
      let thought = '';
      let handle: GgufContext | undefined = undefined;
      const running = () => state === 'running';
      const stop = (problem: LocalModelProblem, started: boolean) => {
        if (running()) {
          state = 'over';
          Queue.failCauseUnsafe(queue, Cause.fail(failure(problem, started)));
        }
      };
      const say = (text: string) => {
        // A parser may revise what it already parsed; nothing said is taken back.
        if (text.length > streamed.length && text.startsWith(streamed)) {
          Queue.offerUnsafe(queue, { kind: 'delta', text: text.slice(streamed.length) });
          streamed = text;
        }
      };
      const think = (text: string) => {
        if (text.length > thought.length && text.startsWith(thought)) {
          Queue.offerUnsafe(queue, { kind: 'reasoning', text: text.slice(thought.length) });
          thought = text;
        }
      };
      const onToken = (data: TokenData) => {
        if (running()) {
          // With thinking on, the parser holds the thinking apart from the answer.
          think(data.reasoning_content ?? '');
          // With the template's parser running, `content` is the answer without
          // tool-call markup, and it is absent while only a tool call is written.
          say(data.accumulated_text === undefined ? streamed + data.token : (data.content ?? ''));
        }
      };
      const finish = (result: CompletionResult) => {
        state = 'over';
        think(result.reasoning_content ?? '');
        say(answerOf(result));
        for (const [index, call] of result.tool_calls.entries()) {
          Queue.offerUnsafe(queue, {
            kind: 'toolCall',
            call: {
              id: call.id ?? `${id}-call-${index}`,
              name: call.function.name,
              arguments: call.function.arguments,
            },
          });
        }
        Queue.offerUnsafe(queue, {
          kind: 'done',
          usage: {
            inputTokens: result.tokens_evaluated,
            outputTokens: result.tokens_predicted,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          stop: stopOf(result),
        });
        Queue.endUnsafe(queue);
      };
      const interrupt = async () => {
        const context = handle;
        if (context !== undefined) {
          // A freed handle throws where the method is called; the finalizer
          // runs this as a void promise, so the throw must not reject it.
          await attempt(() => context.stopCompletion());
        }
      };
      /**
       * Why a release is stopping this answer, when it named one. It is read once,
       * so the answer that follows a release never inherits its cause: only the
       * answer in flight can be interrupted by that release.
       */
      let cause: GgufReleaseCause | undefined = undefined;
      const noteCause = (next: GgufReleaseCause) => {
        cause = next;
      };
      const stoppedProblem = (): LocalModelProblem => {
        const taken = cause;
        cause = undefined;
        return taken ?? 'failed';
      };
      const run = async () => {
        /**
         * Gives up this answer's ownership of the client, once. A release that
         * cannot stop the answer calls it while the answer is still pending, and
         * the answer calls it again when it settles or fails: whichever happens
         * first ends the turn, and the second call must not clear state a newer
         * answer has taken over.
         */
        let released = false;
        const giveUp = () => {
          if (released) {
            return;
          }
          released = true;
          if (running()) {
            stop(stoppedProblem(), streamed !== '');
          }
          if (abandon === giveUp) {
            abandon = undefined;
          }
          if (noteRelease === noteCause) {
            noteRelease = undefined;
          }
          cause = undefined;
          busy = false;
          inflight = undefined;
        };
        try {
          const opened = await settled(load(request.model, file));
          if (!opened.ok) {
            if (loaded?.fileId === request.model) {
              loaded = undefined;
            }
            stop('unavailable', false);
            return;
          }
          handle = opened.value;
          if (!running()) {
            return;
          }
          const completion = opened.value.completion(paramsOf(request, file), onToken);
          inflight = completion;
          abandon = giveUp;
          // Only now can a release interrupt this answer rather than the load.
          noteRelease = noteCause;
          const finished = await settled(completion);
          if (!finished.ok) {
            stop('failed', streamed !== '');
            return;
          }
          const result = readCompletion(finished.value);
          if (!result.ok) {
            stop('failed', streamed !== '');
            return;
          }
          if (result.value.interrupted) {
            // Stopped by a release: the app went to the background, the model was
            // deleted, or another model was loaded. Only the release that named a
            // cause makes this something other than a model failure.
            stop(stoppedProblem(), streamed !== '');
            return;
          }
          finish(result.value);
        } catch {
          stop('failed', streamed !== '');
        } finally {
          giveUp();
        }
      };
      return Effect.andThen(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (running()) {
              // Interrupted mid-answer: stop llama.cpp. Its last result is ignored.
              state = 'over';
              void interrupt();
            }
          })
        ),
        () => Effect.sync(() => void run())
      );
    });

  return {
    release,
    client: {
      stream: request =>
        Stream.suspend(() => {
          const file = fileOf(request.model);
          if (file === undefined) {
            return Stream.fail(failure('unavailable', false));
          }
          if (busy) {
            return Stream.fail(failure('busy', false));
          }
          busy = true;
          return answer(request, file);
        }),
    },
  };
}

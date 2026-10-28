import {
  type ModelClientService,
  ModelError,
  type ModelEvent,
  type ModelRequest,
} from '@kilocode/harness-sdk';
import { Cause, Effect, Queue, Stream } from 'effect';
import { type ContextParams, type LlamaContext, type TokenData } from 'llama.rn';

import { LocalModelError, type LocalModelProblem } from './local-model-error';
import { type GgufModelFile, settled } from './gguf-records';
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
 * Loads a projector into an open context. True only when llama.cpp reports
 * that the model now reads images; the projector's own release runs with the
 * context's.
 */
export async function loadProjector(
  context: Pick<GgufContext, 'initMultimodal' | 'getMultimodalSupport'>,
  projector: string,
  gpu: boolean
): Promise<boolean> {
  if (!(await context.initMultimodal({ path: projector, use_gpu: gpu }))) {
    return false;
  }
  const support = await context.getMultimodalSupport();
  return support.vision;
}

/** Fixed copy only: llama.cpp errors are never shown or logged. */
function failure(problem: LocalModelProblem, started: boolean): ModelError {
  return new ModelError({
    reason: started ? 'stream' : 'unsupported',
    cause: new LocalModelError(problem),
  });
}

export type GgufModelClient = {
  readonly client: ModelClientService;
  /**
   * Stops any answer and frees the loaded context. With a file id, only when
   * that file is the one loaded, so deleting another model keeps this one.
   */
  readonly release: (fileId?: string) => Promise<void>;
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
  let busy = false;
  let sequence = 0;

  const release = async (fileId?: string) => {
    const current = loaded;
    if (current === undefined || (fileId !== undefined && current.fileId !== fileId)) {
      return;
    }
    loaded = undefined;
    const context = await settled(current.context);
    if (!context.ok) {
      return;
    }
    if (inflight !== undefined) {
      await settled(context.value.stopCompletion());
      await settled(inflight);
    }
    await settled(context.value.release());
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
    const vision = await settled(loadProjector(context, file.projector, runtime.gpu));
    if (!vision.ok || !vision.value) {
      await settled(context.release());
      throw new Error('projector');
    }
    return context;
  };

  const load = async (fileId: string, file: GgufModelFile): Promise<GgufContext> => {
    if (loaded?.fileId === fileId) {
      return loaded.context;
    }
    await release();
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
        if (handle !== undefined) {
          await settled(handle.stopCompletion());
        }
      };
      const run = async () => {
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
            // Stopped by a release: the app went to the background or the model was deleted.
            stop('failed', streamed !== '');
            return;
          }
          finish(result.value);
        } catch {
          stop('failed', streamed !== '');
        } finally {
          busy = false;
          inflight = undefined;
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

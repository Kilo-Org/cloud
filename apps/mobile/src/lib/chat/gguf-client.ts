import {
  type ModelClientService,
  ModelError,
  type ModelEvent,
  type ModelRequest,
} from '@kilocode/harness-sdk';
import { Effect, Stream } from 'effect';
import { type ContextParams, type LlamaContext, type TokenData } from 'llama.rn';

import { LocalModelError, type LocalModelProblem } from './local-model-error';
import { type GgufModelFile, settled } from './gguf-records';
import { answerOf, type CompletionResult, paramsOf, readCompletion, stopOf } from './gguf-template';

/** The part of a llama.rn context this client drives. */
export type GgufContext = Pick<LlamaContext, 'model' | 'completion' | 'stopCompletion' | 'release'>;

export type GgufRuntime = {
  readonly init: (params: ContextParams) => Promise<GgufContext>;
};

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

  const load = async (fileId: string, file: GgufModelFile): Promise<GgufContext> => {
    if (loaded?.fileId === fileId) {
      return loaded.context;
    }
    await release();
    const context = runtime.init({
      model: file.path,
      n_ctx: file.contextWindow,
      n_parallel: 1,
    });
    loaded = { fileId, context };
    return context;
  };

  const answer = (request: ModelRequest, file: GgufModelFile) =>
    Stream.async<ModelEvent, ModelError>(emit => {
      sequence += 1;
      const id = `gguf-${sequence}`;
      let state: 'running' | 'over' = 'running';
      let streamed = '';
      let handle: GgufContext | undefined = undefined;
      const running = () => state === 'running';
      const stop = (problem: LocalModelProblem, started: boolean) => {
        if (running()) {
          state = 'over';
          void emit.fail(failure(problem, started));
        }
      };
      const say = (text: string) => {
        // A parser may revise what it already parsed; nothing said is taken back.
        if (text.length > streamed.length && text.startsWith(streamed)) {
          void emit.single({ kind: 'delta', text: text.slice(streamed.length) });
          streamed = text;
        }
      };
      const onToken = (data: TokenData) => {
        if (running()) {
          // With the template's parser running, `content` is the answer without
          // tool-call markup, and it is absent while only a tool call is written.
          say(data.accumulated_text === undefined ? streamed + data.token : (data.content ?? ''));
        }
      };
      const finish = async (result: CompletionResult) => {
        state = 'over';
        say(answerOf(result));
        for (const [index, call] of result.tool_calls.entries()) {
          void emit.single({
            kind: 'toolCall',
            call: {
              id: call.id ?? `${id}-call-${index}`,
              name: call.function.name,
              arguments: call.function.arguments,
            },
          });
        }
        await emit.single({
          kind: 'done',
          usage: {
            inputTokens: result.tokens_evaluated,
            outputTokens: result.tokens_predicted,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          stop: stopOf(result),
        });
        await emit.end();
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
          await finish(result.value);
        } catch {
          stop('failed', streamed !== '');
        } finally {
          busy = false;
          inflight = undefined;
        }
      };
      void run();
      return Effect.sync(() => {
        if (running()) {
          // Interrupted mid-answer: stop llama.cpp. Its last result is ignored.
          state = 'over';
          void interrupt();
        }
      });
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

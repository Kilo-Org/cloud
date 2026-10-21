import { Cause, Effect, Layer, Option, Stream } from 'effect';
import type { ApiKind } from '../../core/catalog.js';
import type { FetchLike } from '../../core/fetch.js';
import { ModelClient, ModelError, type ModelClientService } from '../../core/model.js';
import { RetryPolicy, type RetryPolicyService } from '../../core/retry.js';
import { modelStream } from '../gateway/stream.js';
import { remoteWireFor } from './wires.js';
import { postRemote, safeRemoteError } from './http.js';

interface RemoteModelConfig {
  /** An API root, e.g. https://api.openai.com/v1, not a gateway origin. */
  readonly baseUrl: string;
  readonly apiKind: ApiKind;
  /** Chat Completions output limit field; defaults to max_completion_tokens. */
  readonly completionTokenField?: 'max_completion_tokens' | 'max_tokens';
  /** Must honor redirect:'error' before sending credentials to any redirect target. */
  readonly fetch: FetchLike;
  /** Only credentials owned by this backend. Resolved again before each attempt. */
  readonly headers: () => Effect.Effect<Readonly<Record<string, string>>, ModelError>;
}

const remoteModelClient = (
  config: RemoteModelConfig,
  retry: RetryPolicyService
): ModelClientService => ({
  stream: request =>
    modelStream(
      Effect.sync(() => remoteWireFor(config.apiKind, config.completionTokenField)),
      (wire, handle) => postRemote(config, retry, { wire, request, handle })
    ).pipe(
      Stream.catchAllCause(cause => {
        const failure = Cause.failureOption(cause);
        if (Option.isSome(failure)) {
          return Stream.fail(safeRemoteError(failure.value));
        }
        return Cause.isInterruptedOnly(cause)
          ? Stream.failCause(cause)
          : Stream.fail(new ModelError({ reason: 'transport', cause: 'Remote model failure' }));
      })
    ),
});

const layerRemoteModel = (
  config: RemoteModelConfig
): Layer.Layer<ModelClient, never, RetryPolicy> =>
  Layer.effect(
    ModelClient,
    Effect.map(RetryPolicy, retry => remoteModelClient(config, retry))
  );

export type { RemoteModelConfig };
export { layerRemoteModel, remoteModelClient };

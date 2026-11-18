import { Effect, Layer } from 'effect';
import { post, type HttpCaller, type HttpConfig } from './http.js';
import { ModelCatalog, type ModelCatalogService } from '../../core/catalog.js';
import { ModelClient, ModelError, type ModelRequest } from '../../core/model.js';
import { RetryPolicy } from '../../core/retry.js';
import { TokenSource } from '../../core/token.js';
import { modelStream, type AbortHandle } from './stream.js';
import type { Wire } from './wire/wire.js';
import { wireFor } from './wires.js';

/** Everything the gateway resolved once, at layer build. */
interface Gateway extends HttpCaller {
  readonly catalog: ModelCatalogService;
}

/** One call, with the handle that stops it when the caller stops listening. */
interface Sent {
  readonly wire: Wire;
  readonly request: ModelRequest;
  readonly handle: AbortHandle | undefined;
}

/**
 * Rendering is wrapped because a wire refuses what its shape cannot carry: an
 * image in a media type the provider does not take throws here, and that is a
 * failed call, not a crash.
 */
const bodyFor = (gateway: Gateway, sent: Sent) =>
  Effect.try({
    try: () => JSON.stringify(sent.wire.toBody(sent.request)),
    catch: cause => new ModelError({ reason: 'unsupported', cause }),
  }).pipe(
    Effect.flatMap(body =>
      post(gateway, {
        path: sent.wire.path,
        body,
        session: sent.request.cacheKey,
        signal: sent.handle?.signal,
      })
    )
  );

/**
 * The kilo gateway plugin. It picks the best shape the model speaks.
 *
 * The catalog, the token and the retry policy are resolved once here, so the
 * request path carries no lookup and the returned client needs no context.
 */
const layerKiloGateway = (
  config: HttpConfig
): Layer.Layer<ModelClient, never, ModelCatalog | TokenSource | RetryPolicy> =>
  Layer.effect(
    ModelClient,
    Effect.gen(function* () {
      const gateway: Gateway = {
        config,
        catalog: yield* ModelCatalog,
        token: yield* TokenSource,
        retry: yield* RetryPolicy,
      };
      return {
        stream: request =>
          modelStream(wireFor(gateway.catalog, request.model), (wire, handle) =>
            bodyFor(gateway, { wire, request, handle })
          ),
      };
    })
  );

export type { HttpConfig as KiloGatewayConfig };
export { layerKiloGateway };

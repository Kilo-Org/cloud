import { Effect, Layer, Option, Ref, Stream } from 'effect';
import { type ApiKind, pickKind } from './api-kind.js';
import { type HttpConfig, post } from './kilo-gateway-http.js';
import {
  ModelClient,
  ModelError,
  type ModelEvent,
  type ModelReply,
  type ModelRequest,
  type ModelUsage,
  zeroUsage,
} from './model.js';
import { dataOf, frames } from './sse.js';
import { completionsWire } from './wire/completions.js';
import { messagesWire } from './wire/messages.js';
import { responsesWire } from './wire/responses.js';
import type { Wire } from './wire/wire.js';

interface KiloGatewayConfig extends HttpConfig {
  /**
   * Which shapes a model speaks. The gateway resolves this from the serving
   * provider and publishes it nowhere, so the caller supplies it.
   */
  readonly apiKinds: (model: string) => readonly ApiKind[];
}

const wires: Readonly<Record<ApiKind, Wire>> = {
  messages: messagesWire,
  responses: responsesWire,
  chat_completions: completionsWire,
};

const wireFor = (config: KiloGatewayConfig, model: string): Effect.Effect<Wire, ModelError> => {
  const kind = pickKind(config.apiKinds(model));
  return kind === undefined
    ? Effect.fail(new ModelError({ reason: 'unsupported', cause: model }))
    : Effect.succeed(wires[kind]);
};

const send = (
  config: KiloGatewayConfig,
  request: ModelRequest
): Effect.Effect<ModelReply, ModelError> =>
  wireFor(config, request.model).pipe(
    Effect.flatMap(wire =>
      post(config, wire.path, JSON.stringify(wire.toBody({ ...request, stream: false }))).pipe(
        Effect.flatMap(response =>
          Effect.tryPromise({
            try: () => response.text(),
            catch: cause => new ModelError({ reason: 'transport', cause }),
          })
        ),
        Effect.flatMap(text =>
          Effect.try({
            try: () => wire.toReply(JSON.parse(text)),
            catch: cause => new ModelError({ reason: 'body', cause }),
          })
        )
      )
    )
  );

const chunksOf = (response: { readonly stream?: () => AsyncIterable<string> }) => {
  const body = response.stream;
  return body === undefined
    ? Stream.fail(new ModelError({ reason: 'transport', cause: 'the caller supplied no stream' }))
    : Stream.fromAsyncIterable(body(), cause => new ModelError({ reason: 'transport', cause }));
};

const eventsOf = (wire: Wire, usage: Ref.Ref<ModelUsage>, data: string) =>
  Effect.try({
    try: () => JSON.parse(data) as unknown,
    catch: cause => new ModelError({ reason: 'body', cause }),
  }).pipe(
    Effect.tap(event => {
      const part = wire.toUsage(event);
      return part === undefined ? Effect.void : Ref.update(usage, held => ({ ...held, ...part }));
    }),
    Effect.map(event => Option.fromNullable(wire.toDelta(event)))
  );

const stream = (
  config: KiloGatewayConfig,
  request: ModelRequest
): Stream.Stream<ModelEvent, ModelError> =>
  Stream.unwrap(
    Effect.map(Ref.make(zeroUsage), usage =>
      Stream.unwrap(
        Effect.map(wireFor(config, request.model), wire =>
          Stream.fromEffect(
            post(config, wire.path, JSON.stringify(wire.toBody({ ...request, stream: true })))
          ).pipe(
            Stream.flatMap(chunksOf),
            Stream.mapAccum('', (buffer: string, chunk: string) => {
              const framed = frames(buffer + chunk);
              return [framed.rest, framed.events];
            }),
            Stream.flattenIterables,
            Stream.filterMap(frame => Option.fromNullable(dataOf(frame))),
            Stream.mapEffect(data => eventsOf(wire, usage, data)),
            Stream.filterMap(text => text),
            Stream.map((text): ModelEvent => ({ kind: 'delta', text })),
            Stream.concat(
              Stream.fromEffect(Ref.get(usage)).pipe(
                Stream.map((counts): ModelEvent => ({ kind: 'done', usage: counts }))
              )
            )
          )
        )
      )
    )
  );

/** The kilo gateway plugin. It picks the best shape the model speaks. */
const layerKiloGateway = (config: KiloGatewayConfig): Layer.Layer<ModelClient> =>
  Layer.succeed(ModelClient, {
    send: request => send(config, request),
    stream: request => stream(config, request),
  });

export type { KiloGatewayConfig };
export { layerKiloGateway };

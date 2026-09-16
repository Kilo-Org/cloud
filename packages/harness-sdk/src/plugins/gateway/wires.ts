import { Effect } from 'effect';
import { pickKind } from './api-kind.js';
import { type ApiKind, CatalogError, type ModelCatalogService } from '../../core/catalog.js';
import { ModelError } from '../../core/model.js';
import { completionsWire } from './wire/completions.js';
import { messagesWire } from './wire/messages.js';
import { responsesWire } from './wire/responses.js';
import type { Wire } from './wire/wire.js';

/** Keyed by `ApiKind`, so picking a kind always finds a wire. */
const wires: Readonly<Record<ApiKind, Wire>> = {
  messages: messagesWire,
  responses: responsesWire,
  chat_completions: completionsWire,
};

/** A catalog that cannot answer is a model the package must not guess at. */
const asModelError = (error: CatalogError | ModelError): ModelError =>
  error instanceof CatalogError
    ? new ModelError({ reason: 'unsupported', cause: error.cause })
    : error;

/** Asks the catalog what the model speaks and returns the best wire for it. */
const wireFor = (catalog: ModelCatalogService, model: string): Effect.Effect<Wire, ModelError> =>
  catalog.facts(model).pipe(
    Effect.mapError(asModelError),
    Effect.flatMap(facts => {
      const kind = pickKind(facts.apiKinds);
      return kind === undefined
        ? Effect.fail(new ModelError({ reason: 'unsupported', cause: model }))
        : Effect.succeed(wires[kind]);
    })
  );

export { wireFor, wires };

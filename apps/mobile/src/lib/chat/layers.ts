import { Effect, Layer } from 'effect';
import {
  EntropySource,
  layerAssembler,
  layerBackoff,
  layerKiloGateway,
  ModelCatalog,
  type ModelFacts,
  TokenError,
  TokenSource,
  type TokenSourceService,
  ToolRegistry,
} from '@kilocode/harness-sdk';
import { layerExpoStore } from '@kilocode/harness-sdk/plugins/store/expo';
import * as Crypto from 'expo-crypto';
import { type SQLiteDatabase } from 'expo-sqlite';

import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';
import { chatFetch } from './fetch';
import { chatTools } from './tools';

/**
 * The plugins the chat runs on.
 *
 * `layerKilo` is the wiring most callers want and it builds its own catalog
 * from a fixed table. This app's table is not fixed: the models come from the
 * gateway while the app is running, and a session opened before they arrived
 * would never learn its own context window and so would never compact. So the
 * layers are composed by hand, over a catalog that reads what the app knows now.
 */

/**
 * The one gateway shape every provider it relays speaks.
 *
 * The gateway resolves a model's shapes from the serving provider and does not
 * publish them, and they are not all three. A model served over
 * `chat_completions` alone — the local deterministic model is one — is refused
 * with "This model does not support the messages API" if the session sends any
 * other shape, which read on screen as a question that failed to deliver. So a
 * model nothing has told us about is asked over `chat_completions`: it is the
 * one shape every provider the gateway relays accepts, and the one that keeps
 * a chat working on the models that speak nothing else. The catalog the app
 * reads carries no per-model shapes, so this is the answer for every model
 * until one publishes them.
 */
export const RELAYED_SHAPE: ModelFacts = { apiKinds: ['chat_completions'] };

/** What the app has been told about each model, replaced as the catalog loads. */
let known: ReadonlyMap<string, ModelFacts> = new Map();

/**
 * The facts for one gateway model: the shape above, and the window it names.
 *
 * Only the window comes from the list. The shapes do not: the gateway relays a
 * model from whichever provider serves it and says nothing about which shapes
 * that provider speaks, so the assumption above stands for every model.
 */
export function modelFactsFor(model: {
  readonly id: string;
  readonly context_length?: number | null;
}): ModelFacts {
  return model.context_length === null || model.context_length === undefined
    ? RELAYED_SHAPE
    : { ...RELAYED_SHAPE, contextWindow: model.context_length };
}

/** Takes the gateway's model list as the facts a session needs. */
export function rememberModelFacts(
  models: readonly { readonly id: string; readonly context_length?: number | null }[]
): void {
  known = new Map(models.map(model => [model.id, modelFactsFor(model)]));
}

/**
 * Randomness, which React Native has no global `crypto` for.
 *
 * The SDK's default reads `crypto.getRandomValues` and says so: a runtime
 * without one supplies its own. This app already ships expo-crypto — it is
 * what encrypts the database — so the identifiers come from the same source
 * as the key.
 */
const layerEntropy = Layer.succeed(EntropySource, {
  bytes: (count: number) => Crypto.getRandomBytes(count),
});

/** One catalog instance, shared by the session and the gateway as it must be. */
const layerCatalog = Layer.succeed(ModelCatalog, {
  facts: (model: string) => Effect.succeed(known.get(model) ?? RELAYED_SHAPE),
});

/**
 * The signed-in credential, read for every call.
 *
 * The app's token expires and is refreshed under this, and a chat outlives
 * both. Reading it per call is why: a source that held a string would start
 * failing with 401 while still believing in it.
 */
const layerToken = Layer.succeed(TokenSource, {
  get: () =>
    Effect.tryPromise({
      try: async () => {
        const token = await getAuthTokenForRequest();
        if (token === null) {
          throw new Error('the app is signed out');
        }
        return token;
      },
      catch: cause => new TokenError({ cause }),
    }),
} satisfies TokenSourceService);

/**
 * The tools a session may name. It is assembled once: the set is frozen for
 * the life of a session, so a registry rebuilt per call would be the same one
 * every time.
 */
const layerTools = Layer.succeed(ToolRegistry, { tools: chatTools() });

/** Whose credit pays for the chat. */
export type ChatOrg =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly id: string };

export function chatLayers(database: SQLiteDatabase, org: ChatOrg) {
  const gateway = layerKiloGateway({ baseUrl: API_BASE_URL, org, fetch: chatFetch }).pipe(
    Layer.provide(Layer.mergeAll(layerCatalog, layerToken, layerBackoff(2)))
  );
  return Layer.mergeAll(
    layerAssembler,
    layerEntropy,
    layerCatalog,
    layerTools,
    gateway,
    layerExpoStore(database)
  );
}

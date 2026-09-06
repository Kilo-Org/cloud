import { Context, Data, type Effect } from 'effect';

/** The three shapes the gateway speaks. A model does not always speak all three. */
type ApiKind = 'messages' | 'responses' | 'chat_completions';

/** What the package needs to know about a model before it calls one. */
interface ModelFacts {
  /** Which shapes this model speaks. An empty list means the package cannot call it. */
  readonly apiKinds: readonly ApiKind[];
  /** The most tokens this model will produce, when the catalog knows the number. */
  readonly maxOutputTokens?: number;
  /**
   * The most tokens this model reads in one request, when the catalog knows the
   * number. A session compacts itself when it fills a share of this. Without it
   * a session never compacts: a guessed window would either cut a conversation
   * that fit, or fail to save one that did not.
   */
  readonly contextWindow?: number;
}

class CatalogError extends Data.TaggedError('harness/CatalogError')<{
  readonly model: string;
  readonly cause: unknown;
}> {}

/**
 * Answers what a model can do.
 *
 * This is a plugin because nobody publishes these facts in one place. The
 * gateway resolves the shapes from the serving provider and exposes them
 * nowhere, a hard-coded table goes stale, and a live lookup costs a request.
 * The caller decides which trade it wants.
 *
 * It returns an Effect so a plugin may fetch. A plugin that fetches must cache,
 * because this sits on the request path and one question asks two or three
 * times: the gateway asks which shape to send, the session asks for the window
 * before it decides whether to compact, and it asks for the output ceiling too
 * unless the caller named one.
 */
interface ModelCatalogService {
  readonly facts: (model: string) => Effect.Effect<ModelFacts, CatalogError>;
}

class ModelCatalog extends Context.Tag('harness/ModelCatalog')<
  ModelCatalog,
  ModelCatalogService
>() {}

export type { ApiKind, ModelCatalogService, ModelFacts };
export { CatalogError, ModelCatalog };

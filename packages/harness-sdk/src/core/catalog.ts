import { Context, Data, type Effect } from 'effect';

/** The three shapes the gateway speaks. A model does not always speak all three. */
type ApiKind = 'messages' | 'responses' | 'chat_completions';

/** What the package needs to know about a model before it calls one. */
interface ModelFacts {
  /** Which shapes this model speaks. An empty list means the package cannot call it. */
  readonly apiKinds: readonly ApiKind[];
  /** The most tokens this model will produce, when the catalog knows the number. */
  readonly maxOutputTokens?: number;
}

class CatalogError extends Data.TaggedError('CatalogError')<{
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
 * It returns an Effect so a plugin may fetch. A plugin that fetches must cache:
 * this sits on the request path.
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

import { Context, type Effect } from 'effect';

/**
 * Makes an identifier of the form `{prefix}_{ulid}`. The identifier must sort by
 * the order it was made in, so two identifiers made in the same millisecond
 * still order.
 */
interface IdGeneratorService {
  readonly generate: (prefix: string) => Effect.Effect<string>;
}

class IdGenerator extends Context.Tag('harness/IdGenerator')<IdGenerator, IdGeneratorService>() {}

export type { IdGeneratorService };
export { IdGenerator };

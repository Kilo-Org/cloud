import { Context, Data } from 'effect';

/**
 * The platform could not supply randomness. Every runtime that has a source
 * exposes it differently, and a mobile runtime may have none until a polyfill
 * is installed, so this is reported at wiring time rather than at the first
 * identifier.
 */
class EntropyError extends Data.TaggedError('harness/EntropyError')<{
  readonly cause: unknown;
}> {}

/**
 * Where random bytes come from.
 *
 * This is the one thing the package cannot do for itself on every runtime:
 * Node, a browser, a worker and a mobile app each hold their randomness
 * somewhere different. It is a plugin point so that the core needs no platform
 * at all, and so a caller on a runtime the package has never seen can supply
 * its own rather than wait for the package to learn about it.
 *
 * The call is synchronous because it sits on the identifier path, which runs
 * twice per question.
 */
interface EntropySourceService {
  /** Returns `count` random bytes. Each byte must be uniform over 0..255. */
  readonly bytes: (count: number) => Uint8Array;
}

class EntropySource extends Context.Tag('harness/EntropySource')<
  EntropySource,
  EntropySourceService
>() {}

export type { EntropySourceService };
export { EntropyError, EntropySource };

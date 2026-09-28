import { Layer, Schedule } from 'effect';
import { RetryPolicy } from '../../core/retry.js';
import type { ModelError } from '../../core/model.js';

/** A status the gateway or the network may recover from on its own. */
const retryStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const isRetryable = (error: ModelError): boolean =>
  error.reason === 'transport' ||
  (error.reason === 'status' && retryStatuses.has(error.status ?? 0));

/**
 * The core policy: exponential backoff with jitter, up to `retries` further
 * attempts. Jitter matters because a gateway outage makes every session retry
 * on the same beat, and an unjittered fleet retries as one.
 */
const backoff = (retries: number): Schedule.Schedule<unknown, ModelError> =>
  Schedule.exponential('200 millis').pipe(
    Schedule.jittered,
    Schedule.whileInput(isRetryable),
    Schedule.intersect(Schedule.recurs(retries))
  );

const layerBackoff = (retries = 3): Layer.Layer<RetryPolicy> =>
  Layer.succeed(RetryPolicy, { schedule: backoff(retries) });

/** Tries once and gives up. Useful when the caller owns its own retry loop. */
const layerNoRetry: Layer.Layer<RetryPolicy> = Layer.succeed(RetryPolicy, {
  schedule: Schedule.stop,
});

export { backoff, layerBackoff, layerNoRetry };

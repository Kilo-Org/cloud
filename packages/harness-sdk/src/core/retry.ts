import { Context, type Schedule } from 'effect';
import type { ModelError } from './model.js';

/**
 * Decides whether and how a failed call is tried again.
 *
 * This is a plugin because the right policy belongs to the caller, not to the
 * package. A phone on a slow link wants patience. A batch job wants to fail
 * fast and move on. A caller behind its own rate limiter wants no retry at all.
 *
 * The schedule sees the error, so it decides both how long to wait and whether
 * the error is worth waiting for.
 */
interface RetryPolicyService {
  readonly schedule: Schedule.Schedule<unknown, ModelError>;
}

class RetryPolicy extends Context.Tag('harness/RetryPolicy')<RetryPolicy, RetryPolicyService>() {}

export type { RetryPolicyService };
export { RetryPolicy };

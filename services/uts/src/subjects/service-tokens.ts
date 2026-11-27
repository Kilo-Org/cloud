/**
 * The workload check of the `/internal/` routes: an STS token (design 6.1) for audience `uts`
 * with the route's one scope. The web app is the only caller (`UTS_INTERNAL_WORKLOADS`).
 *
 * * `verified`: the token is valid for this route; `workload` is its subject.
 * * `missing`: no bearer credential. `invalid`: a credential that is not a valid STS token for
 *   audience `uts`. `insufficient_scope`: a valid token for another scope.
 * * `workload_refused`: a valid token for this scope from a caller the environment does not admit;
 *   `workload` is its service workload, or null for a caller that is not a service.
 * * `unavailable`: the check cannot run (no verifier, no key set); the route answers 503.
 */
export type ServiceTokenCheck =
  | { status: 'verified'; workload: string }
  | { status: 'missing' | 'invalid' | 'insufficient_scope' }
  | { status: 'workload_refused'; workload: string | null }
  | { status: 'unavailable'; retryAfterSeconds: number };

export type ServiceTokenVerifier = (
  authorization: string | null,
  scope: string
) => Promise<ServiceTokenCheck>;

/** How long a caller waits while a route cannot serve it (no identity store, a refused caller). */
export const NO_VERIFIER_RETRY_SECONDS = 60;

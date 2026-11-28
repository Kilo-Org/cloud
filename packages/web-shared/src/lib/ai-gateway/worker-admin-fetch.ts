import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { parseInternalServiceEndpoint } from '@kilocode/web-shared/lib/internal-service-url';
import * as z from 'zod';
import { autoRoutingCredential, type AutoRoutingSenderRoute } from './auto-routing-sender';

export type WorkerAdminResult<T> = {
  status: number;
  body: T;
};

export const ErrorBodySchema = z.object({ error: z.string(), message: z.string().optional() });
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/**
 * Default deadline for a worker admin call without its own signal. The slowest admin
 * route observed in production, starting a benchmark run, took up to 22 s before run
 * initialization left the request.
 */
export const WORKER_ADMIN_TIMEOUT_MS = 30_000;

/** The error body of a call that went out without a token: a later call may hold one. */
export const WORKER_TOKEN_UNAVAILABLE_ERROR = 'No service token for the worker; try again';

export type WorkerAdminCredential =
  | {
      kind: 'ready';
      authorization: string;
      /** An STS token is for the Worker's origin only: a redirect fails rather than carry it on. */
      redirect?: 'error';
    }
  /** No secret (or an unreadable one) under `legacy`, or a refused `sts` configuration. */
  | { kind: 'unconfigured' }
  /** `sts` without a token before `signal` aborted, or STS gave none. */
  | { kind: 'token_unavailable' };

/**
 * The `Authorization` header of one admin request to `endpoint` in route family `route`: the
 * internal secret while the app's switch for the route is `legacy`, or an STS token under `sts`
 * (`auto-routing-sender.ts`). Nothing is sent without one, and `sts` never falls back to the secret.
 */
export async function workerAdminCredential(
  endpoint: URL,
  route: AutoRoutingSenderRoute,
  signal?: AbortSignal
): Promise<WorkerAdminCredential> {
  const sender = await autoRoutingCredential(route, { url: endpoint, signal });
  switch (sender.kind) {
    case 'legacy': {
      // A secret that cannot be read sends nothing and answers like a missing one, without its
      // reason.
      const secret = await readInternalApiSecret().catch(() => '');
      return secret
        ? { kind: 'ready', authorization: `Bearer ${secret}` }
        : { kind: 'unconfigured' };
    }
    case 'sts':
      return { kind: 'ready', authorization: sender.authorization, redirect: 'error' };
    case 'unavailable':
      return sender.reason === 'token_unavailable'
        ? { kind: 'token_unavailable' }
        : { kind: 'unconfigured' };
  }
}

type WorkerAdminRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

export function createWorkerAdminFetch(options: {
  workerUrl: string | undefined;
  unconfiguredError: string;
}) {
  /**
   * One admin call in route family `route`. One deadline covers the credential read (a cold STS
   * mint included) and the request: the caller's signal, else `WORKER_ADMIN_TIMEOUT_MS`.
   */
  return async function fetchAdmin<T>(
    route: AutoRoutingSenderRoute,
    path: string,
    init: WorkerAdminRequestInit,
    schema: z.ZodType<T>
  ): Promise<WorkerAdminResult<T | ErrorBody>> {
    const endpoint = parseInternalServiceEndpoint(options.workerUrl, path);
    if (!endpoint) {
      return { status: 500, body: { error: options.unconfiguredError } };
    }

    const deadline = init.signal ? null : AbortSignal.timeout(WORKER_ADMIN_TIMEOUT_MS);
    const signal = init.signal ?? deadline;
    const credential = await workerAdminCredential(endpoint, route, signal ?? undefined);
    if (credential.kind !== 'ready') {
      if (deadline?.aborted) {
        return { status: 504, body: { error: 'Worker request timed out' } };
      }
      // The caller's own signal ended the wait: answer as an aborted request would.
      init.signal?.throwIfAborted();
      return credential.kind === 'unconfigured'
        ? { status: 500, body: { error: options.unconfiguredError } }
        : { status: 503, body: { error: WORKER_TOKEN_UNAVAILABLE_ERROR } };
    }

    try {
      const response = await fetch(endpoint.toString(), {
        ...init,
        signal,
        headers: {
          authorization: credential.authorization,
          ...init.headers,
        },
        ...(credential.redirect ? { redirect: credential.redirect } : {}),
      });
      if (!response.ok) {
        const parsed = ErrorBodySchema.safeParse(
          await response.json().catch((error: unknown) => {
            if (deadline?.aborted) throw error;
            return undefined;
          })
        );
        return {
          status: response.status,
          body: parsed.success ? parsed.data : { error: `Request failed: ${response.status}` },
        };
      }
      return { status: response.status, body: schema.parse(await response.json()) };
    } catch (error) {
      if (deadline?.aborted) {
        return { status: 504, body: { error: 'Worker request timed out' } };
      }
      throw error;
    }
  };
}

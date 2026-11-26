import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { parseInternalServiceEndpoint } from '@kilocode/web-shared/lib/internal-service-url';
import * as z from 'zod';

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

type WorkerAdminRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

export function createWorkerAdminFetch(options: {
  workerUrl: string | undefined;
  unconfiguredError: string;
}) {
  return async function fetchAdmin<T>(
    path: string,
    init: WorkerAdminRequestInit,
    schema: z.ZodType<T>
  ): Promise<WorkerAdminResult<T | ErrorBody>> {
    const endpoint = parseInternalServiceEndpoint(options.workerUrl, path);
    // A secret that cannot be read sends nothing and answers like a missing one, without its reason.
    const internalApiSecret = endpoint ? await readInternalApiSecret().catch(() => '') : '';
    if (!internalApiSecret || !endpoint) {
      return {
        status: 500,
        body: { error: options.unconfiguredError },
      };
    }

    const deadline = init.signal ? null : AbortSignal.timeout(WORKER_ADMIN_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint.toString(), {
        ...init,
        signal: init.signal ?? deadline,
        headers: {
          authorization: `Bearer ${internalApiSecret}`,
          ...init.headers,
        },
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

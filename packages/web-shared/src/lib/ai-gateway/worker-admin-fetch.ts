import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { parseInternalServiceEndpoint } from '@kilocode/web-shared/lib/internal-service-url';
import * as z from 'zod';

export type WorkerAdminResult<T> = {
  status: number;
  body: T;
};

export type ErrorBody = { error: string };
export const ErrorBodySchema = z.object({ error: z.string() });

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
    if (!INTERNAL_API_SECRET || !endpoint) {
      return {
        status: 500,
        body: { error: options.unconfiguredError },
      };
    }

    const response = await fetch(endpoint.toString(), {
      ...init,
      headers: {
        authorization: `Bearer ${INTERNAL_API_SECRET}`,
        ...init.headers,
      },
    });

    const body: unknown = await response.json();
    if (!response.ok) {
      const parsedError = ErrorBodySchema.safeParse(body);
      return {
        status: response.status,
        body: parsedError.success
          ? parsedError.data
          : { error: `Request failed: ${response.status}` },
      };
    }

    return {
      status: response.status,
      body: schema.parse(body),
    };
  };
}

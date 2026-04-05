import { getEnvVariable } from '@/lib/dotenvx';
import { unstable_cache } from 'next/cache';
import * as z from 'zod';

/**
 * NOTE: This is a copy from the landing page project.
 * This should either move to a shared library OR remove the PostHog dependency from the landing page in the long term
 */

export type PostHogQueryResponse =
  | {
      status: 'ok';
      body: { results?: unknown[][] };
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { status: 'error'; statusCode: number; error: any };

/**
 * Execute a HogQL query against PostHog's query API
 *
 * @param name - A descriptive name for the query (for logging/debugging)
 * @param query - The HogQL query string to execute
 * @returns Query response with results or error
 */
export async function posthogQuery(name: string, query: string): Promise<PostHogQueryResponse> {
  const apiKey = getEnvVariable('POSTHOG_QUERY_API_KEY');
  if (!apiKey) {
    throw new Error('No PostHog Query API Key');
  }

  const response = await fetch('https://us.posthog.com/api/projects/141915/query/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: {
        kind: 'HogQLQuery',
        query,
      },
      name,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    return {
      status: 'error',
      statusCode: response.status,
      error: await response.json().catch(() => ({ error: 'Unknown error' })),
    };
  }

  return {
    status: 'ok',
    body: await response.json(),
  };
}
export function cachedPosthogQuery<Output>(schema: z.ZodType<Output[]>) {
  return unstable_cache(
    async (name: string, query: string) => {
      const startTime = performance.now();
      const response = await posthogQuery(name, query);
      if (response.status !== 'ok') {
        throw new Error(`${name} query failed: ${JSON.stringify(response.error, undefined, 2)}`);
      }
      const result = schema.safeParse(response.body.results);
      if (!result.success) {
        throw new Error(`${name} parse failed: ${z.prettifyError(result.error)}`);
      }
      console.debug(
        `[cachedPosthogQuery] ${name} returned ${result.data.length} rows in ${performance.now() - startTime}ms`
      );
      return result.data;
    },
    undefined,
    { revalidate: 60 * 60 * 24 } // 24 hours
  );
}

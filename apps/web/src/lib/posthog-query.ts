import { getEnvVariable } from '@/lib/dotenvx';

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

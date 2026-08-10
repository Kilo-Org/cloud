import { z } from 'zod';
import type { FetchLike } from '@/src/shared/auth';
import type { EvalTabResult } from '@/src/shared/tab-debugger';

interface WebSearchToolCall {
  readonly query?: string | undefined;
}

export interface WebSearchContext {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  readonly organizationId?: string | undefined;
  readonly token: string;
}

const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 1200;

const exaResponseSchema = z.object({
  results: z.array(
    z.object({
      publishedDate: z.string().optional(),
      text: z.string().optional(),
      title: z.string().nullish(),
      url: z.string(),
    })
  ),
});

const errorBodySchema = z.object({ error: z.string() });

const trimTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;

type FetchOutcome = { readonly ok: true; readonly response: Response } | { readonly ok: false; readonly reason: string };

const postSearch = async (query: string, context: WebSearchContext): Promise<FetchOutcome> => {
  try {
    const response = await context.fetch(
      `${trimTrailingSlash(context.apiBaseUrl)}/api/exa/search`,
      {
        body: JSON.stringify({
          contents: { text: { maxCharacters: MAX_SNIPPET_CHARS } },
          numResults: MAX_RESULTS,
          query,
        }),
        headers: {
          Authorization: `Bearer ${context.token}`,
          'Content-Type': 'application/json',
          ...(context.organizationId === undefined || context.organizationId === ''
            ? {}
            : { 'x-kilocode-organizationid': context.organizationId }),
        },
        method: 'POST',
      }
    );
    return { ok: true, response };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'network error' };
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const toResultEntry = (result: z.infer<typeof exaResponseSchema>['results'][number]) => ({
  ...(result.publishedDate === undefined ? {} : { publishedDate: result.publishedDate }),
  ...(typeof result.title === 'string' && result.title !== '' ? { title: result.title } : {}),
  ...(result.text === undefined ? {} : { text: result.text.slice(0, MAX_SNIPPET_CHARS) }),
  url: result.url,
});

/**
 * Search the web through the Kilo Exa proxy (`/api/exa/search`). The backend
 * owns auth, the monthly free allowance, and per-request billing; the
 * extension only forwards the user's bearer token. Results come back as
 * compact title/url/snippet records — search results are untrusted data.
 */
export const executeWebSearchToolCall = async (
  toolCall: WebSearchToolCall,
  context: WebSearchContext
): Promise<EvalTabResult> => {
  const query = toolCall.query?.trim();

  if (query === undefined || query === '') {
    return { error: 'Search query is required.', ok: false };
  }

  const outcome = await postSearch(query, context);

  if (!outcome.ok) {
    return { error: `Web search failed: ${outcome.reason}`, ok: false };
  }

  const { response } = outcome;
  const body = await readJson(response);

  if (!response.ok) {
    // The proxy explains allowance and balance failures in its error body; pass that through so the model can tell the user why.
    const errorBody = errorBodySchema.safeParse(body);
    const detail = errorBody.success ? ` ${errorBody.data.error}` : '';
    return {
      error: `Web search failed with status ${String(response.status)}.${detail}`,
      ok: false,
    };
  }

  const parsed = exaResponseSchema.safeParse(body);

  if (!parsed.success) {
    return { error: 'Web search returned an invalid response.', ok: false };
  }

  const results = parsed.data.results.slice(0, MAX_RESULTS).map(result => toResultEntry(result));

  return {
    ok: true,
    value:
      results.length === 0
        ? { message: 'No results found. Try a different query.', results: [] }
        : { results },
  };
};

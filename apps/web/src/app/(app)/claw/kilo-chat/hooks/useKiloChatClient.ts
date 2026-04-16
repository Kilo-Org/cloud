import { useMemo } from 'react';
import { KILO_CHAT_URL } from '@/lib/constants';

export class KiloChatApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`Kilo Chat API error: ${status}`);
    this.name = 'KiloChatApiError';
  }
}

type FetchOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
};

async function kiloChatFetch<T>(
  path: string,
  token: string,
  opts: FetchOptions = {},
): Promise<T> {
  const url = new URL(path, KILO_CHAT_URL);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new KiloChatApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Returns a memoized API client bound to the caller's auth token.
 */
export function useKiloChatClient(getToken: () => Promise<string>) {
  const client = useMemo(() => {
    return {
      fetch: async <T>(path: string, opts?: FetchOptions): Promise<T> => {
        const token = await getToken();
        return kiloChatFetch<T>(path, token, opts);
      },
    };
  }, [getToken]);

  return client;
}

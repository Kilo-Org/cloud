import type { z } from 'zod';
import { O11Y_KILO_GATEWAY_CLIENT_SECRET, O11Y_SERVICE_URL } from '@/lib/config.server';

export class O11yRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getO11yUrl(pathname: string, searchParams?: URLSearchParams): string {
  if (!O11Y_SERVICE_URL) {
    throw new Error('O11Y_SERVICE_URL is not configured');
  }
  const url = new URL(pathname, O11Y_SERVICE_URL);
  if (searchParams) {
    url.search = searchParams.toString();
  }
  return url.toString();
}

function authHeaders(): HeadersInit {
  return {
    'X-O11Y-ADMIN-TOKEN': O11Y_KILO_GATEWAY_CLIENT_SECRET || '',
  };
}

type FetchO11yJsonParams<T> = {
  path: string;
  schema: z.ZodSchema<T>;
  method?: 'GET' | 'PUT' | 'DELETE';
  body?: unknown;
  searchParams?: URLSearchParams;
  errorMessage: string;
  parseErrorMessage: string;
};

export async function fetchO11yJson<T>({
  path,
  schema,
  method = 'GET',
  body,
  searchParams,
  errorMessage,
  parseErrorMessage,
}: FetchO11yJsonParams<T>): Promise<T> {
  const response = await fetch(getO11yUrl(path, searchParams), {
    method,
    headers: {
      ...authHeaders(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let message = errorMessage;
    try {
      const data: unknown = JSON.parse(await response.text());
      if (typeof data === 'object' && data !== null && 'error' in data) {
        message = String((data as { error?: string }).error || errorMessage);
      }
    } catch {
      // non-JSON error body (e.g. HTML 5xx) — fall through with default message
    }
    throw new O11yRequestError(message, response.status);
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new O11yRequestError(parseErrorMessage, 502);
  }

  return parsed.data;
}

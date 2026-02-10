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

  const data = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error?: string }).error || errorMessage)
        : errorMessage;
    throw new O11yRequestError(message, response.status);
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new O11yRequestError(parseErrorMessage, 502);
  }

  return parsed.data;
}

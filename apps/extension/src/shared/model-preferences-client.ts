import { z } from 'zod';
import type { FetchLike } from './auth';

export type ModelPreferencesErrorKind = 'retryable' | 'terminal';

export class ModelPreferencesError extends Error {
  readonly status: number | null;
  readonly trpcCode: string | null;

  constructor(
    message: string,
    {
      cause,
      status,
      trpcCode,
    }: {
      readonly cause?: unknown;
      readonly status: number | null;
      readonly trpcCode: string | null;
    }
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ModelPreferencesError';
    this.status = status;
    this.trpcCode = trpcCode;
  }
}

interface ModelPreferencesBaseOptions {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  readonly signal?: AbortSignal;
  readonly token: string;
}

interface ModelPreferencesClientOptions extends ModelPreferencesBaseOptions {
  readonly organizationId?: string | undefined;
}

interface ModelFavoriteMutationOptions extends ModelPreferencesBaseOptions {
  readonly model: string;
}

/* The read accepts an organization scope; the mutations are per user and carry none. */
type ModelPreferencesRequestOptions<Data> = {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  readonly procedure: string;
  readonly signal?: AbortSignal;
  readonly successEnvelopeSchema: z.ZodType<{ result: { data: Data } }>;
  readonly token: string;
} & (
  | { readonly method: 'GET'; readonly organizationId?: string | undefined }
  | { readonly body: string; readonly method: 'POST' }
);

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const favoritesDataSchema = z.object({
  favorites: z.array(z.string()),
  lastSelected: z.unknown().optional(),
});

const mutationDataSchema = z.object({
  success: z.literal(true),
});

const favoritesSuccessEnvelopeSchema = z.object({
  result: z.object({
    data: favoritesDataSchema,
  }),
});

const mutationSuccessEnvelopeSchema = z.object({
  result: z.object({
    data: mutationDataSchema,
  }),
});

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    data: z
      .object({
        code: z.string(),
        httpStatus: z.number().optional(),
        path: z.string().optional(),
      })
      .optional(),
    message: z.string(),
  }),
});

const buildProcedureUrl = (
  apiBaseUrl: string,
  procedure: string,
  input?: Record<string, unknown>
): string => {
  const base = `${trimTrailingSlash(apiBaseUrl)}/api/trpc/${procedure}`;

  if (input === undefined) {
    return base;
  }

  return `${base}?input=${encodeURIComponent(JSON.stringify(input))}`;
};

const getQueryInput = (organizationId: string | undefined): Record<string, unknown> | undefined => {
  if (organizationId === undefined || organizationId === '') {
    return undefined;
  }

  return { organizationId };
};

const performModelPreferencesFetch = async ({
  body,
  fetch,
  signal,
  token,
  url,
  method,
}: {
  readonly body?: string;
  readonly fetch: FetchLike;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly token: string;
  readonly url: string;
}): Promise<Response> => {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };

  try {
    return await fetch(url, {
      headers,
      method,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw new ModelPreferencesError('Model preferences request failed', {
      cause: error,
      status: null,
      trpcCode: null,
    });
  }
};

const requestModelPreferences = async <Data>(
  options: ModelPreferencesRequestOptions<Data>
): Promise<Data> => {
  const { apiBaseUrl, fetch, procedure, signal, successEnvelopeSchema, token } = options;
  const url =
    options.method === 'GET'
      ? buildProcedureUrl(apiBaseUrl, procedure, getQueryInput(options.organizationId))
      : buildProcedureUrl(apiBaseUrl, procedure);

  const response = await performModelPreferencesFetch({
    fetch,
    method: options.method,
    token,
    url,
    ...(options.method === 'POST' ? { body: options.body } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
  // eslint-disable-next-line unicorn/no-useless-undefined -- initialized in the try block below
  let payload: unknown = undefined;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ModelPreferencesError('Model preferences response was not JSON', {
      cause: error,
      status: response.status,
      trpcCode: null,
    });
  }
  const errorEnvelope = errorEnvelopeSchema.safeParse(payload);

  if (errorEnvelope.success) {
    throw new ModelPreferencesError(errorEnvelope.data.error.message, {
      status: response.status,
      trpcCode: errorEnvelope.data.error.data?.code ?? null,
    });
  }

  if (!response.ok) {
    throw new ModelPreferencesError(`Model preferences request failed: ${response.status}`, {
      status: response.status,
      trpcCode: null,
    });
  }

  const successEnvelope = successEnvelopeSchema.safeParse(payload);

  if (!successEnvelope.success) {
    throw new ModelPreferencesError('Model preferences response envelope was malformed', {
      status: response.status,
      trpcCode: null,
    });
  }

  return successEnvelope.data.result.data;
};

export const classifyModelPreferencesError = (error: unknown): ModelPreferencesErrorKind => {
  if (!(error instanceof ModelPreferencesError)) {
    return 'retryable';
  }

  if (error.status === 401 || error.status === 403) {
    return 'terminal';
  }

  if (error.trpcCode === 'UNAUTHORIZED' || error.trpcCode === 'FORBIDDEN') {
    return 'terminal';
  }

  return 'retryable';
};

export const fetchModelPreferences = async ({
  apiBaseUrl,
  fetch,
  organizationId,
  signal,
  token,
}: ModelPreferencesClientOptions): Promise<{
  favorites: string[];
  lastSelected: unknown;
}> => {
  const data = await requestModelPreferences({
    apiBaseUrl,
    fetch,
    method: 'GET',
    procedure: 'modelPreferences.get',
    successEnvelopeSchema: favoritesSuccessEnvelopeSchema,
    token,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(signal === undefined ? {} : { signal }),
  });

  return { favorites: data.favorites, lastSelected: data.lastSelected };
};

/*
 * Favorites are stored per user, so add and remove are unscoped on purpose:
 * neither mutation takes the organization selector the read accepts.
 */
export const addModelFavorite = async ({
  apiBaseUrl,
  fetch,
  model,
  signal,
  token,
}: ModelFavoriteMutationOptions): Promise<void> => {
  await requestModelPreferences({
    apiBaseUrl,
    body: JSON.stringify({ model }),
    fetch,
    method: 'POST',
    procedure: 'modelPreferences.addFavorite',
    successEnvelopeSchema: mutationSuccessEnvelopeSchema,
    token,
    ...(signal === undefined ? {} : { signal }),
  });
};

export const removeModelFavorite = async ({
  apiBaseUrl,
  fetch,
  model,
  signal,
  token,
}: ModelFavoriteMutationOptions): Promise<void> => {
  await requestModelPreferences({
    apiBaseUrl,
    body: JSON.stringify({ model }),
    fetch,
    method: 'POST',
    procedure: 'modelPreferences.removeFavorite',
    successEnvelopeSchema: mutationSuccessEnvelopeSchema,
    token,
    ...(signal === undefined ? {} : { signal }),
  });
};

import {
  type ByokPrivateProviderCredentials,
  type ByokPrivateModel,
} from '@kilocode/db/schema-types';
import { resolveByokPrivateProviderUpstreamAuth } from '@kilocode/web-shared/lib/ai-gateway/byok-private-provider/direct-provider';
import {
  MAX_LISTED_MODELS,
  modelEntries,
  parseByokPrivateProviderModelsResponse,
} from '@/lib/byok/private-provider-models';
import { privateProviderOriginChanged } from '@/lib/byok/private-provider-origin';
import { signBedrockRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/aws-bedrock-signing';
import {
  findUpstreamUrlViolation,
  isUpstreamUrlPolicyEnforced,
  type UpstreamUrlViolation,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';
import {
  fetchWithUpstreamUrlPolicy,
  UpstreamUrlPolicyError,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-policy-fetch';

const REQUEST_TIMEOUT_MS = 15_000;
/** Bounds a model import that follows pages; each request is still limited to `REQUEST_TIMEOUT_MS`. */
const MODEL_LIST_BUDGET_MS = 30_000;
const MAX_MODEL_PAGES = 10;
/** Pages are not requested once less of the budget than this is left. */
const MIN_PAGE_TIMEOUT_MS = 1_000;
/** The page size asked for once an Anthropic-style list says there are more pages. */
const MODEL_PAGE_SIZE = 1_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_VERSION = '2023-06-01';

/** A failure whose message is safe to show to the organization member who configured the private provider. */
export class ByokPrivateProviderRequestError extends Error {}

const URL_POLICY_MESSAGES = {
  invalid_url: 'The private provider URL is not a valid URL.',
  non_https: 'The private provider URL must use HTTPS.',
  non_public_host: 'The private provider URL must point to a public host.',
  non_public_address: 'The private provider URL host resolves to a non-public address.',
  dns_lookup_failed:
    'The private provider host could not be resolved. Check the URL and try again.',
  redirect:
    'The private provider responded with a redirect, which is not followed. Use the final URL.',
} as const satisfies Record<UpstreamUrlViolation | 'redirect', string>;

/** Why `baseUrl` may not be used for a private provider. */
export async function findByokPrivateProviderBaseUrlViolation(
  baseUrl: string
): Promise<string | null> {
  if (!isUpstreamUrlPolicyEnforced()) return null;
  const decision = await findUpstreamUrlViolation(baseUrl);
  return decision.allowed ? null : URL_POLICY_MESSAGES[decision.violation];
}

function credentialSecrets(credentials: ByokPrivateProviderCredentials): string[] {
  switch (credentials.type) {
    case 'api_key':
    case 'x-api-key':
      return [credentials.api_key];
    case 'aws_bedrock':
      return [credentials.access_key_id, credentials.secret_access_key];
    case 'service_account':
      return [credentials.private_key_id, credentials.private_key];
  }
}

/**
 * Headers that authorize the request as gateway requests to the private provider do, and every secret
 * value that went into them.
 */
async function authorizedHeaders({
  url,
  method,
  body,
  credentials,
  extraHeaders,
}: {
  url: string;
  method: string;
  body: string;
  credentials: ByokPrivateProviderCredentials;
  extraHeaders: Record<string, string>;
}): Promise<{ headers: Headers; secrets: string[] }> {
  const headers = new Headers({ accept: 'application/json' });
  if (body) headers.set('content-type', 'application/json');
  const auth = await resolveByokPrivateProviderUpstreamAuth(credentials);
  const secrets = [...credentialSecrets(credentials), auth.apiKey].filter(Boolean);
  if (auth.apiKeyHeader === 'x-api-key') {
    headers.set('x-api-key', auth.apiKey);
    headers.set('anthropic-version', ANTHROPIC_VERSION);
  } else if (!auth.awsBedrock) {
    headers.set('authorization', `Bearer ${auth.apiKey}`);
  }
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  if (!auth.awsBedrock) return { headers, secrets };
  return {
    headers: await signBedrockRequest({ url, method, headers, body, credentials: auth.awsBedrock }),
    secrets,
  };
}

async function readTextWithLimit(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ByokPrivateProviderRequestError('The private provider response is too large.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export type ByokPrivateProviderResponse = {
  status: number;
  ok: boolean;
  text: string;
  /** The secret values sent with the request; an upstream may echo them in an error. */
  secrets: readonly string[];
};

/**
 * Sends one request to an organization's private provider with its credentials, under the upstream URL
 * policy (`fetchWithUpstreamUrlPolicy`). The response is capped.
 */
export async function fetchByokPrivateProvider({
  url,
  method,
  body = '',
  credentials,
  headers: extraHeaders = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
}: {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  credentials: ByokPrivateProviderCredentials;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ByokPrivateProviderResponse> {
  const { headers, secrets } = await authorizedHeaders({
    url,
    method,
    body,
    credentials,
    extraHeaders,
  });

  let response: Response;
  try {
    response = await fetchWithUpstreamUrlPolicy(url, {
      method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof UpstreamUrlPolicyError) {
      throw new ByokPrivateProviderRequestError(URL_POLICY_MESSAGES[error.rejection]);
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ByokPrivateProviderRequestError(
        `The private provider did not respond within ${Math.ceil(timeoutMs / 1000)} seconds.`
      );
    }
    throw new ByokPrivateProviderRequestError('The private provider could not be reached.');
  }

  return {
    status: response.status,
    ok: response.ok,
    text: await readTextWithLimit(response),
    secrets,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !(key in current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current.trim() !== '' ? current.trim() : undefined;
}

/**
 * Where the page after `page` is, if the response says there is one: Anthropic's `has_more` with
 * `last_id` (`?after_id=`), or a `next` link. `null` means this is the last page; `undefined`
 * means there is another page that cannot be followed. A link must stay on the private provider's
 * origin, because every request carries its credentials.
 */
function nextModelsPageUrl({
  page,
  currentUrl,
  baseUrl,
}: {
  page: unknown;
  currentUrl: string;
  baseUrl: string;
}): string | null | undefined {
  const link =
    stringField(page, 'next') ??
    stringField(page, 'next_page_url') ??
    stringField(page, 'links', 'next');
  if (link) {
    try {
      const url = new URL(link, currentUrl);
      return privateProviderOriginChanged(baseUrl, url.href) ? undefined : url.href;
    } catch {
      return undefined;
    }
  }
  const hasMore = typeof page === 'object' && page !== null && 'has_more' in page && page.has_more;
  if (hasMore !== true) return null;
  const lastId = stringField(page, 'last_id');
  if (!lastId) return undefined;
  const url = new URL(`${baseUrl}/models`);
  url.searchParams.set('after_id', lastId);
  url.searchParams.set('limit', String(MODEL_PAGE_SIZE));
  return url.href;
}

/**
 * The models the private provider lists at `GET <base_url>/models`, following pagination within a
 * bounded number of pages, models and time. `truncated` is set when the list is known or likely
 * to hold more models than were read.
 */
export async function fetchByokPrivateProviderModels({
  baseUrl,
  credentials,
}: {
  baseUrl: string;
  credentials: ByokPrivateProviderCredentials;
}): Promise<{ models: ByokPrivateModel[]; truncated: boolean }> {
  const deadline = Date.now() + MODEL_LIST_BUDGET_MS;
  const entries: unknown[] = [];
  const visited = new Set<string>();
  let truncated = false;
  let url = `${baseUrl}/models`;

  for (let pageNumber = 1; ; pageNumber++) {
    visited.add(url);
    const isFirstPage = pageNumber === 1;
    let page: unknown;
    try {
      const response = await fetchByokPrivateProvider({
        url,
        method: 'GET',
        credentials,
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()),
      });
      if (!response.ok) {
        throw new ByokPrivateProviderRequestError(
          `The private provider could not list its models: ${describeByokPrivateProviderError(response)}`
        );
      }
      page = parseJson(response.text);
      if (page === undefined) {
        throw new ByokPrivateProviderRequestError(
          'The private provider returned a model list that is not JSON.'
        );
      }
    } catch (error) {
      // The first page decides whether the import works; a later failure only cuts the list short.
      if (isFirstPage || !(error instanceof ByokPrivateProviderRequestError)) throw error;
      truncated = true;
      break;
    }
    entries.push(...modelEntries(page));

    const next = nextModelsPageUrl({ page, currentUrl: url, baseUrl });
    if (next === null) break;
    if (
      next === undefined ||
      visited.has(next) ||
      pageNumber >= MAX_MODEL_PAGES ||
      entries.length >= MAX_LISTED_MODELS ||
      deadline - Date.now() < MIN_PAGE_TIMEOUT_MS
    ) {
      truncated = true;
      break;
    }
    url = next;
  }

  const models = parseByokPrivateProviderModelsResponse(entries);
  return { models, truncated: truncated || models.length >= MAX_LISTED_MODELS };
}

const REDACTED = '[redacted]';
const MAX_ERROR_DETAIL_LENGTH = 300;
/** Bounds the work of redaction, which scales with the text length. */
const MAX_REDACTED_TEXT_LENGTH = 4_000;
const MIN_MASKED_PREFIX_LENGTH = 8;
const MIN_MASKED_SUFFIX_LENGTH = 4;

/** The values to remove for one secret: all of it, and the ends upstreams show of a masked key. */
function secretFragments(secret: string): string[] {
  const fragments = [secret];
  if (secret.length <= MAX_REDACTED_TEXT_LENGTH / 16) {
    for (let length = secret.length - 1; length >= MIN_MASKED_PREFIX_LENGTH; length--) {
      fragments.push(secret.slice(0, length));
    }
    for (let length = secret.length - 1; length >= MIN_MASKED_SUFFIX_LENGTH; length--) {
      fragments.push(secret.slice(-length));
    }
  }
  return fragments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `text` without the secrets, or the beginning or end of one, as an upstream may echo them. */
export function redactByokPrivateProviderSecrets(text: string, secrets: readonly string[]): string {
  const fragments = [...new Set(secrets.filter(Boolean).flatMap(secretFragments))].sort(
    (a, b) => b.length - a.length
  );
  const bounded = text.slice(0, MAX_REDACTED_TEXT_LENGTH);
  if (fragments.length === 0) return bounded;
  // One pass, longest fragment first, so a replacement is never matched again.
  const pattern = new RegExp(fragments.map(fragment => escapeRegExp(fragment)).join('|'), 'g');
  return bounded.replace(pattern, REDACTED);
}

/**
 * A short, human-readable reason from an upstream error body: the `error.message` of a JSON body,
 * otherwise the beginning of the text. Credentials the upstream echoes are redacted.
 */
export function describeByokPrivateProviderError(response: ByokPrivateProviderResponse): string {
  let detail: string | undefined;
  try {
    const json: unknown = JSON.parse(response.text);
    const error = typeof json === 'object' && json !== null && 'error' in json ? json.error : json;
    const message =
      typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null && 'message' in error
          ? error.message
          : undefined;
    if (typeof message === 'string') detail = message;
  } catch {
    detail = response.text.trim() || undefined;
  }
  const status = `HTTP ${response.status}`;
  if (!detail) return status;
  const redacted = redactByokPrivateProviderSecrets(detail, response.secrets).slice(
    0,
    MAX_ERROR_DETAIL_LENGTH
  );
  return `${status}: ${redacted}`;
}

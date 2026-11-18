import { type ByokEndpointCredentials, type ByokEndpointModel } from '@kilocode/db/schema-types';
import { resolveByokEndpointUpstreamAuth } from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint/direct-provider';
import { parseByokEndpointModelsResponse } from '@/lib/byok/endpoint-models';
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
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_VERSION = '2023-06-01';

/** A failure whose message is safe to show to the organization member who configured the endpoint. */
export class ByokEndpointRequestError extends Error {}

const URL_POLICY_MESSAGES = {
  invalid_url: 'The endpoint URL is not a valid URL.',
  non_https: 'The endpoint URL must use HTTPS.',
  non_public_host: 'The endpoint URL must point to a public host.',
  non_public_address: 'The endpoint URL host resolves to a non-public address.',
  dns_lookup_failed: 'The endpoint host could not be resolved. Check the URL and try again.',
  redirect: 'The endpoint responded with a redirect, which is not followed. Use the final URL.',
} as const satisfies Record<UpstreamUrlViolation | 'redirect', string>;

/** Why `baseUrl` may not be used for an endpoint. */
export async function findByokEndpointBaseUrlViolation(baseUrl: string): Promise<string | null> {
  if (!isUpstreamUrlPolicyEnforced()) return null;
  const decision = await findUpstreamUrlViolation(baseUrl);
  return decision.allowed ? null : URL_POLICY_MESSAGES[decision.violation];
}

function credentialSecrets(credentials: ByokEndpointCredentials): string[] {
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
 * Headers that authorize the request as gateway requests to the endpoint do, and every secret
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
  credentials: ByokEndpointCredentials;
  extraHeaders: Record<string, string>;
}): Promise<{ headers: Headers; secrets: string[] }> {
  const headers = new Headers({ accept: 'application/json' });
  if (body) headers.set('content-type', 'application/json');
  const auth = await resolveByokEndpointUpstreamAuth(credentials);
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
      throw new ByokEndpointRequestError('The endpoint response is too large.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export type ByokEndpointResponse = {
  status: number;
  ok: boolean;
  text: string;
  /** The secret values sent with the request; an upstream may echo them in an error. */
  secrets: readonly string[];
};

/**
 * Sends one request to an organization's endpoint with its credentials, under the upstream URL
 * policy (`fetchWithUpstreamUrlPolicy`). The response is capped.
 */
export async function fetchByokEndpoint({
  url,
  method,
  body = '',
  credentials,
  headers: extraHeaders = {},
}: {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  credentials: ByokEndpointCredentials;
  headers?: Record<string, string>;
}): Promise<ByokEndpointResponse> {
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof UpstreamUrlPolicyError) {
      throw new ByokEndpointRequestError(URL_POLICY_MESSAGES[error.rejection]);
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ByokEndpointRequestError('The endpoint did not respond within 15 seconds.');
    }
    throw new ByokEndpointRequestError('The endpoint could not be reached.');
  }

  return {
    status: response.status,
    ok: response.ok,
    text: await readTextWithLimit(response),
    secrets,
  };
}

/** The models the endpoint lists at `GET <base_url>/models`. */
export async function fetchByokEndpointModels({
  baseUrl,
  credentials,
}: {
  baseUrl: string;
  credentials: ByokEndpointCredentials;
}): Promise<ByokEndpointModel[]> {
  const response = await fetchByokEndpoint({
    url: `${baseUrl}/models`,
    method: 'GET',
    credentials,
  });
  if (!response.ok) {
    throw new ByokEndpointRequestError(
      `The endpoint could not list its models: ${describeByokEndpointError(response)}`
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(response.text);
  } catch {
    throw new ByokEndpointRequestError('The endpoint returned a model list that is not JSON.');
  }
  return parseByokEndpointModelsResponse(json);
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
export function redactByokEndpointSecrets(text: string, secrets: readonly string[]): string {
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
export function describeByokEndpointError(response: ByokEndpointResponse): string {
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
  const redacted = redactByokEndpointSecrets(detail, response.secrets).slice(
    0,
    MAX_ERROR_DETAIL_LENGTH
  );
  return `${status}: ${redacted}`;
}

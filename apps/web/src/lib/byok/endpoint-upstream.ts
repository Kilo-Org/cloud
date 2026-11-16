import {
  BYOK_ENDPOINT_MODEL_PLACEHOLDER,
  type ByokEndpointCredentials,
  type ByokEndpointModel,
} from '@kilocode/db/schema-types';
import {
  getByokEndpointModelBaseUrl,
  hasByokEndpointModelPlaceholder,
  isByokEndpointUrlPolicyEnforced,
  resolveByokEndpointAuth,
} from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
import { parseByokEndpointModelsResponse } from '@/lib/byok/endpoint-models';
import { signBedrockRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/aws-bedrock-signing';
import {
  findUpstreamUrlViolation,
  type UpstreamUrlViolation,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_VERSION = '2023-06-01';
/** Fills `{model}` when a base URL is checked before any model is known. */
const SAMPLE_MODEL_ID = 'model';

/** A failure whose message is safe to show to the organization member who configured the endpoint. */
export class ByokEndpointRequestError extends Error {}

const URL_VIOLATION_MESSAGES = {
  invalid_url: 'The endpoint URL is not a valid URL.',
  non_https: 'The endpoint URL must use HTTPS.',
  non_public_host: 'The endpoint URL must point to a public host.',
  non_public_address: 'The endpoint URL host resolves to a non-public address.',
  dns_lookup_failed: 'The endpoint host could not be resolved. Check the URL and try again.',
} as const satisfies Record<UpstreamUrlViolation, string>;

async function findUrlViolationMessage(url: string): Promise<string | null> {
  if (!isByokEndpointUrlPolicyEnforced()) return null;
  const violation = await findUpstreamUrlViolation(url);
  return violation ? URL_VIOLATION_MESSAGES[violation] : null;
}

/** Why `baseUrl` may not be used for an endpoint, checked with a sample model for `{model}`. */
export function findByokEndpointBaseUrlViolation(baseUrl: string): Promise<string | null> {
  return findUrlViolationMessage(
    getByokEndpointModelBaseUrl({ base_url: baseUrl }, { internal_id: SAMPLE_MODEL_ID })
  );
}

async function authorizedHeaders({
  url,
  method,
  body,
  credentials,
}: {
  url: string;
  method: string;
  body: string;
  credentials: ByokEndpointCredentials;
}): Promise<Headers> {
  const headers = new Headers({ accept: 'application/json' });
  if (body) headers.set('content-type', 'application/json');
  const auth = await resolveByokEndpointAuth(credentials);
  switch (auth.type) {
    case 'api_key':
      if (auth.apiKeyHeader === 'x-api-key') {
        headers.set('x-api-key', auth.apiKey);
        headers.set('anthropic-version', ANTHROPIC_VERSION);
      } else {
        headers.set('authorization', `Bearer ${auth.apiKey}`);
      }
      return headers;
    case 'aws_bedrock':
      return signBedrockRequest({ url, method, headers, body, credentials: auth.credentials });
    case 'secure_proxy':
      throw new ByokEndpointRequestError('Endpoints do not support secure proxy credentials.');
  }
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

export type ByokEndpointResponse = { status: number; ok: boolean; text: string };

/**
 * Sends one request to an organization's endpoint with its credentials. The URL policy applies
 * where it is enforced, redirects are refused rather than followed, and the response is capped.
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
  const violation = await findUrlViolationMessage(url);
  if (violation) throw new ByokEndpointRequestError(violation);

  const headers = await authorizedHeaders({ url, method, body, credentials });
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body || undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ByokEndpointRequestError('The endpoint did not respond within 15 seconds.');
    }
    throw new ByokEndpointRequestError('The endpoint could not be reached.');
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ByokEndpointRequestError(
      'The endpoint responded with a redirect, which is not followed. Use the final URL.'
    );
  }
  return { status: response.status, ok: response.ok, text: await readTextWithLimit(response) };
}

/** The models the endpoint lists at `GET <base_url>/models`. */
export async function fetchByokEndpointModels({
  baseUrl,
  credentials,
}: {
  baseUrl: string;
  credentials: ByokEndpointCredentials;
}): Promise<ByokEndpointModel[]> {
  if (hasByokEndpointModelPlaceholder(baseUrl)) {
    throw new ByokEndpointRequestError(
      `Models cannot be imported when the base URL contains ${BYOK_ENDPOINT_MODEL_PLACEHOLDER}. Add the models manually.`
    );
  }
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

/** A short, human-readable reason from an upstream error body. */
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
  return detail ? `${status}: ${detail.slice(0, 300)}` : status;
}

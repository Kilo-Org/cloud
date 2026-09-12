import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ORGANIZATION_ID_HEADER } from './auth';
import { JsonRpcFailure, type Catalog, type ForwardedAuth } from './types';

/** JSON-RPC error codes (see https://www.jsonrpc.org/specification). */
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32000;

/** Cap for a serialized tool result; over the cap the text is cut and marked. */
export const MAX_RESULT_BYTES = 16 * 1024;
export const TRUNCATION_MARKER = '[truncated]';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

/** Compiled validators, cached per schema object (the schema is the cache key). */
const validatorCache = new WeakMap<object, ValidateFunction>();

function validatorFor(inputSchema: Record<string, unknown>): ValidateFunction {
  const cached = validatorCache.get(inputSchema);
  if (cached) return cached;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(inputSchema);
  } catch (error) {
    throw new JsonRpcFailure(
      INTERNAL_ERROR,
      `The published input schema for this endpoint is not a valid JSON Schema: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  validatorCache.set(inputSchema, validate);
  return validate;
}

function isNoInputSchema(inputSchema: Record<string, unknown>): boolean {
  return Object.keys(inputSchema).filter(key => key !== '$schema').length === 0;
}

function describeViolations(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map(error => {
    const missing = (error.params as { missingProperty?: unknown }).missingProperty;
    const where = error.instancePath || (typeof missing === 'string' ? missing : '') || '(root)';
    return `${where} (${error.keyword}): ${error.message ?? 'invalid'}`;
  });
}

/**
 * Serialize `data` for the tool result, capped at `maxBytes`. Over the cap the
 * JSON is cut at a byte boundary (partial trailing code points dropped) and the
 * `[truncated]` marker is appended so the total stays within the cap.
 */
export function serializeWithCap(
  data: unknown,
  maxBytes = MAX_RESULT_BYTES
): {
  text: string;
  truncated: boolean;
} {
  const full = JSON.stringify(data) ?? 'null';
  const encoded = new TextEncoder().encode(full);
  if (encoded.byteLength <= maxBytes) {
    return { text: full, truncated: false };
  }
  const marker = `\n${TRUNCATION_MARKER}`;
  const budget = Math.max(0, maxBytes - new TextEncoder().encode(marker).byteLength);
  // Cut at a code-point boundary: TextDecoder defaults to non-fatal UTF-8,
  // then drop a trailing replacement character left by a split multi-byte
  // sequence.
  const decoder = new TextDecoder();
  const cut = decoder.decode(encoded.subarray(0, budget)).replace(/\uFFFD+$/, '');
  return { text: `${cut}${marker}`, truncated: true };
}

type TrpcErrorBody = {
  error?: {
    message?: unknown;
    code?: unknown;
    data?: { code?: unknown; httpStatus?: unknown; path?: unknown };
  };
};

/** A well-formed tRPC success body: `{ result: { data } }`. */
type TrpcSuccessBody = { result: { data: unknown } };

function isTrpcSuccessBody(body: unknown): body is TrpcSuccessBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const result = (body as { result?: unknown }).result;
  return (
    typeof result === 'object' &&
    result !== null &&
    Object.prototype.hasOwnProperty.call(result, 'data')
  );
}

function toTrpcFailure(status: number, body: TrpcErrorBody | null, path: string): JsonRpcFailure {
  const json = body?.error ?? {};
  const data = json.data ?? {};
  const message =
    typeof json.message === 'string' && json.message.length > 0
      ? json.message
      : `Upstream Kilo request for "${path}" failed with HTTP ${status}`;
  return new JsonRpcFailure(INTERNAL_ERROR, message, {
    path,
    trpcCode: typeof data.code === 'string' ? data.code : undefined,
    httpStatus: typeof data.httpStatus === 'number' ? data.httpStatus : status,
  });
}

/**
 * Validate `input` against the endpoint's published schema and forward the
 * call to apps/web over its public tRPC GET transport:
 * `{WEB_BASE_URL}/api/trpc/{path}?input=<urlencoded JSON>`. apps/web resolves
 * identity from the forwarded bearer and the organization header — with the
 * s6 flow both come from the verified MCP token: the bearer is the Kilo
 * credential bound to the token's identity, and the organization header is
 * set from the token's org claim (never from a caller-supplied header).
 *
 * Every rejection that can be decided locally (unknown path, schema-invalid
 * input) throws a JsonRpcFailure BEFORE any upstream request is made.
 */
export async function callCatalogEndpoint(options: {
  catalog: Catalog;
  path: string;
  input: unknown;
  auth: ForwardedAuth;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; truncated: boolean }> {
  const { catalog, path, input, auth, webBaseUrl } = options;
  const row = Object.prototype.hasOwnProperty.call(catalog, path) ? catalog[path] : undefined;
  if (!row) {
    throw new JsonRpcFailure(
      INVALID_PARAMS,
      `Unknown path "${path}". The call tool only accepts paths published in the Kilo catalog — run the search tool first and call one of the paths it returns.`,
      { path }
    );
  }

  const schemaIsEmpty = isNoInputSchema(row.inputSchema);
  const sendInput = input !== undefined && input !== null;
  if (schemaIsEmpty && sendInput) {
    throw new JsonRpcFailure(
      INVALID_PARAMS,
      `"${path}" takes no input; omit "input" for this endpoint.`,
      { path }
    );
  }
  if (sendInput && !schemaIsEmpty) {
    const validate = validatorFor(row.inputSchema);
    if (!validate(input)) {
      const violations = describeViolations(validate);
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        `Input does not match the published schema for "${path}": ${violations.join('; ')}`,
        { path, violations }
      );
    }
  }
  if (!sendInput && !schemaIsEmpty) {
    const required = Array.isArray(row.inputSchema['required']) ? row.inputSchema['required'] : [];
    if (required.length > 0) {
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        `Input does not match the published schema for "${path}": (root): input is required (missing ${required
          .map(key => String(key))
          .join(', ')})`,
        { path, violations: ['(root): input is required'] }
      );
    }
  }

  const url = new URL(`/api/trpc/${row.path}`, webBaseUrl);
  if (sendInput) {
    url.searchParams.set('input', JSON.stringify(input));
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: auth.authorization,
  };
  if (auth.organizationId) {
    headers[ORGANIZATION_ID_HEADER] = auth.organizationId;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { method: 'GET', headers });
  } catch {
    // Network-level failure: retryable, and safe to surface — no token in it.
    throw new JsonRpcFailure(
      INTERNAL_ERROR,
      `Could not reach the Kilo API for "${path}". Retry the call.`,
      { path, retryable: true }
    );
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw toTrpcFailure(response.status, body as TrpcErrorBody, path);
  }

  const result = isTrpcSuccessBody(body) ? body.result : null;
  if (!result) {
    throw new JsonRpcFailure(
      INTERNAL_ERROR,
      `The Kilo API replied to "${path}" without a tRPC result body.`,
      { path }
    );
  }
  return serializeWithCap(result.data);
}

import { Validator, type OutputUnit, type Schema, type SchemaDraft } from '@cfworker/json-schema';
import { ORGANIZATION_ID_HEADER } from './auth';
import { isGuardedRow } from './search';
import {
  JsonRpcFailure,
  type Catalog,
  type CatalogRow,
  type ForwardedAuth,
  type ProtectedRequestsApi,
} from './types';

/** JSON-RPC error codes (see https://www.jsonrpc.org/specification). */
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32000;

/** Cap for a serialized tool result; over the cap the text is cut and marked. */
export const MAX_RESULT_BYTES = 16 * 1024;
export const TRUNCATION_MARKER = '[truncated]';

/**
 * Validators, cached per schema object (the schema is the cache key).
 *
 * Validation uses @cfworker/json-schema, never AJV: AJV compiles schemas with
 * `new Function`, which the Workers runtime forbids (Workerd disallows code
 * generation from strings). @cfworker/json-schema evaluates schemas without
 * code generation, so the worker can validate input on the network.
 */
const validatorCache = new WeakMap<object, Validator>();

function draftFor(inputSchema: Record<string, unknown>): SchemaDraft {
  const declared = inputSchema['$schema'];
  if (typeof declared === 'string') {
    if (declared.includes('2020-12')) return '2020-12';
    if (declared.includes('2019-09')) return '2019-09';
    if (declared.includes('draft-07')) return '7';
    if (declared.includes('draft-04')) return '4';
  }
  return '2020-12';
}

function validatorFor(inputSchema: Record<string, unknown>): Validator {
  const cached = validatorCache.get(inputSchema);
  if (cached) return cached;
  const validator = new Validator(inputSchema as Schema, draftFor(inputSchema), false);
  validatorCache.set(inputSchema, validator);
  return validator;
}

function isNoInputSchema(inputSchema: Record<string, unknown>): boolean {
  return Object.keys(inputSchema).filter(key => key !== '$schema').length === 0;
}

function describeViolations(errors: OutputUnit[]): string[] {
  return errors.map(error => {
    const where = error.instanceLocation !== '#' ? error.instanceLocation : '(root)';
    return `${where} (${error.keyword}): ${error.error}`;
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
 * Resolve a catalog row by exact key. `hasOwnProperty` keeps the catalog an
 * allowlist: a prototype name (`__proto__`) is never a row.
 */
function catalogRowFor(catalog: Catalog, path: string): CatalogRow | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, path) ? catalog[path] : undefined;
}

/** The unknown-path refusal shared by `call` and `call_protected`. */
function unknownPath(path: string): JsonRpcFailure {
  return new JsonRpcFailure(
    INVALID_PARAMS,
    `Unknown path "${path}". The call tool only accepts paths published in the Kilo catalog — run the search tool first and call one of the paths it returns.`,
    { path }
  );
}

/**
 * Fail-closed refusal for a protected call that cannot be recorded and later
 * claimed: the pending-request store is unbound, or the grant carries no
 * connection id. A guarded call is never run without a recorded, approved
 * request, and no store message reaches the caller.
 */
function protectedRequestsUnavailable(path: string): JsonRpcFailure {
  return new JsonRpcFailure(
    INTERNAL_ERROR,
    `Could not record this admin or debug request for "${path}". Retry the call; if it keeps failing, reconnect the Kilo MCP server.`,
    { path, retryable: true }
  );
}

/**
 * Validate `input` against the endpoint's published schema and answer whether it
 * is forwarded as the tRPC `input` value. `call`, `call_protected` and
 * `submit_otp`'s recorded-payload re-check all run these exact checks, so the
 * payload the user approves is exactly the payload the upstream receives.
 */
function assertInputMatchesSchema(row: CatalogRow, path: string, input: unknown): boolean {
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
    const { valid, errors } = validatorFor(row.inputSchema).validate(input);
    if (!valid) {
      const violations = describeViolations(errors);
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
  return sendInput;
}

/**
 * The one upstream path `call` and `submit_otp` share: build the tRPC GET URL
 * (`{WEB_BASE_URL}/api/trpc/{path}?input=<urlencoded JSON>`), forward the grant
 * credentials (never a caller-supplied header), map a tRPC error body to a
 * JSON-RPC error, and serialize the result under the byte cap.
 *
 * The caller has already validated `input` and, for a guarded row, obtained the
 * user's approval; this helper never re-decides access.
 */
export async function forwardCatalogCall(options: {
  row: CatalogRow;
  input: unknown;
  auth: ForwardedAuth;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; truncated: boolean }> {
  const { row, input, auth, webBaseUrl } = options;
  const path = row.path;
  const sendInput = input !== undefined && input !== null;
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

/**
 * The `call` tool: validate `input` against the endpoint's published schema and
 * forward a non-guarded endpoint to apps/web over its public tRPC GET transport.
 *
 * A guarded row (admin or debug) is refused locally before any upstream
 * request: `call` never runs one. Without the opt-in the refusal names the
 * checkbox to tick; with it, the refusal points at the OTP-protected tools.
 * apps/web enforces the admin rule again via `adminProcedure`.
 */
export async function callCatalogEndpoint(options: {
  catalog: Catalog;
  path: string;
  input: unknown;
  auth: ForwardedAuth;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; truncated: boolean }> {
  const { catalog, path, input } = options;
  const row = catalogRowFor(catalog, path);
  if (!row) {
    throw unknownPath(path);
  }
  if (isGuardedRow(row)) {
    throw new JsonRpcFailure(
      INVALID_PARAMS,
      options.auth.adminEnabled === true
        ? `"${path}" is an admin or debug endpoint. Use the call_protected tool, then submit_otp with the code from your authenticator app, to run it.`
        : `"${path}" is an admin or debug endpoint. Reconnect the Kilo MCP server and tick "Enable admin and debug actions" at sign-in to allow admin and debug actions.`,
      { path }
    );
  }
  assertInputMatchesSchema(row, path, input);
  return forwardCatalogCall({
    row,
    input,
    auth: options.auth,
    webBaseUrl: options.webBaseUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

/**
 * The `call_protected` tool: record a reviewed admin or debug call and answer
 * the `otp_required` result. No upstream request is made here — the recorded
 * request is claimed by `submit_otp` after the user's authenticator code
 * verifies, and only then does `executeProtectedCall` run it.
 */
export async function requestProtectedCall(options: {
  catalog: Catalog;
  path: string;
  input: unknown;
  auth: ForwardedAuth;
  requests?: ProtectedRequestsApi;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; truncated: boolean }> {
  const { catalog, path, input, auth, requests } = options;
  const row = catalogRowFor(catalog, path);
  if (!row) {
    throw unknownPath(path);
  }
  if (!isGuardedRow(row)) {
    throw new JsonRpcFailure(
      INVALID_PARAMS,
      `"${path}" is not an admin or debug endpoint. Use the call tool for it.`,
      { path }
    );
  }
  // Validate before recording anything: the payload the user approves is
  // exactly the payload the schema describes.
  const sendInput = assertInputMatchesSchema(row, path, input);

  const sessionId = auth.sessionId;
  if (!requests || typeof sessionId !== 'string' || sessionId.length === 0) {
    // Fail-closed: without a store (or a connection id to bind the request to)
    // the call can never be approved, and skipping the request would let a
    // guarded call run unapproved.
    throw protectedRequestsUnavailable(path);
  }

  let created: Awaited<ReturnType<ProtectedRequestsApi['createProtectedRequest']>>;
  try {
    created = await requests.createProtectedRequest({
      sessionId,
      kiloUserId: auth.kiloUserId,
      clientId: auth.clientId,
      path,
      kind: row.debug === true ? 'debug' : 'admin',
      inputJson: sendInput ? JSON.stringify(input) : null,
      nowIso: new Date().toISOString(),
    });
  } catch {
    // A store that throws must not surface its own message (it may embed a
    // credential) and must never let the call run unapproved.
    throw protectedRequestsUnavailable(path);
  }
  const { id, expiresAt } = created;

  return {
    text: JSON.stringify({
      status: 'otp_required',
      request_id: id,
      expires_at: expiresAt,
      message:
        'Approval required: ask the user to read the current code from their authenticator app, then call submit_otp with this request_id and that code. The request expires at ' +
        expiresAt +
        '.',
    }),
    truncated: false,
  };
}

/**
 * The `submit_otp` execution step: run the payload a claimed request recorded.
 *
 * The recorded path must still be a guarded catalog row and the recorded
 * `inputJson` must still satisfy that row's published schema — a mismatch is a
 * local refusal, never a silent rewrite of what the user approved. Only then is
 * the single upstream request made.
 */
export async function executeProtectedCall(options: {
  catalog: Catalog;
  path: string;
  inputJson: string | null;
  auth: ForwardedAuth;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; truncated: boolean }> {
  const { catalog, path, inputJson } = options;
  const row = catalogRowFor(catalog, path);
  if (!row || !isGuardedRow(row)) {
    // The catalog changed under a pending request (the row was demoted or
    // removed); the recorded call can no longer run.
    throw new JsonRpcFailure(
      INVALID_PARAMS,
      `The recorded admin or debug call for "${path}" is no longer available. Start a new admin or debug call with call_protected.`,
      { path }
    );
  }

  let input: unknown;
  if (inputJson !== null) {
    try {
      input = JSON.parse(inputJson);
    } catch {
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        `The recorded input for "${path}" is not valid JSON. Start a new admin or debug call with call_protected.`,
        { path }
      );
    }
  }
  assertInputMatchesSchema(row, path, input);

  return forwardCatalogCall({
    row,
    input,
    auth: options.auth,
    webBaseUrl: options.webBaseUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

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

/**
 * A tRPC success body: `{ result: { data } }`. A void procedure serializes to
 * `{ result: {} }` — `JSON.stringify` drops the `undefined` `data` field — so a
 * `result` object without `data` is a successful void result, not a missing
 * body. Missing the distinction would report an error after a write landed and
 * push an agent to re-apply it.
 *
 * Only the shapes tRPC actually emits count: an empty object (void) or an
 * object whose only key is `data`. An arbitrary 2xx body that happens to carry
 * a `result` object — `{"result":{"nonsense":true}}` — is not a success
 * envelope, and reading it as a successful void write would tell the agent a
 * mutation landed that may never have run.
 */
type TrpcSuccessBody = { result: { data?: unknown } };

function isTrpcSuccessBody(body: unknown): body is TrpcSuccessBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const result = (body as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
  return Object.keys(result).every(key => key === 'data');
}

/**
 * Whether the response body is an app-level tRPC error: apps/web answered and
 * the failure's outcome is known. A tRPC error envelope always carries a
 * non-empty message (its error formatter fills one in). A body without one — an
 * HTML/text gateway page, or a platform JSON error like
 * `{"error":"FUNCTION_INVOCATION_TIMEOUT"}` — is a gateway/function failure,
 * not an app-level answer.
 */
function hasTrpcErrorMessage(body: TrpcErrorBody | null): boolean {
  const message = body?.error?.message;
  return typeof message === 'string' && message.length > 0;
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
 * The failure for a mutation whose outcome is unknown: the request may have
 * reached apps/web (a rejected fetch, a gateway/function non-2xx with no tRPC
 * error body, an unreadable or non-tRPC 2xx body), so the write may have
 * applied. Never advertise a blind retry — a retry would duplicate the
 * mutation (e.g. two agent profiles from one request). Safe to surface — no
 * token in it.
 */
function ambiguousMutationFailure(path: string): JsonRpcFailure {
  return new JsonRpcFailure(
    INTERNAL_ERROR,
    `Could not reach the Kilo API for "${path}". This mutation may or may not have been applied — check the current state before retrying.`,
    { path, ambiguous: true }
  );
}

/**
 * The failure for a mutation whose app-level error cannot be pinned to a
 * pre-write rejection. tRPC raises a 5xx-class error (INTERNAL_SERVER_ERROR,
 * NOT_IMPLEMENTED) *after* the resolver returned — output validation, a
 * post-resolver middleware, a serialization failure — so the write can have
 * committed and still come back as an error envelope. The outcome is unknown:
 * say so instead of inviting a duplicate write. A 4xx-class tRPC error is a
 * rejection the app returns before the write (validation, authorization,
 * not-found, precondition), so it keeps the ordinary mapping. Safe to surface —
 * no token in it.
 */
function ambiguousMutationAppError(path: string, status: number): JsonRpcFailure {
  return new JsonRpcFailure(
    INTERNAL_ERROR,
    `The Kilo API failed on "${path}" (HTTP ${status}). This mutation may or may not have been applied — check the current state before retrying.`,
    { path, ambiguous: true, httpStatus: status }
  );
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
 * The one upstream path `call` and `submit_otp` share: forward an
 * already-validated call to apps/web over its public tRPC transport, chosen by
 * the catalog row's `kind`:
 *
 * - `query`: `GET {WEB_BASE_URL}/api/trpc/{path}` with `?input=<JSON>` only when
 *   input is sent. A network failure is retryable: a GET changed nothing.
 * - `mutation`: `POST` to the same URL with no `input` query parameter,
 *   `Content-Type: application/json`, and a JSON body (`{}` for a procedure
 *   that takes no input). tRPC accepts a mutation only on POST and its
 *   json content-type handler reads `req.json()`, so an empty body is a 400 —
 *   a body is always sent. A network failure leaves the outcome unknown, so it
 *   is reported as ambiguous, never as a blind retry. A gateway/function
 *   failure (a non-2xx with no tRPC error message, like app.kilo.ai's
 *   FUNCTION_INVOCATION_TIMEOUT 504) and a 2xx whose result cannot be read are
 *   the same unknown-outcome case: the POST reached the platform, so a
 *   mutation reports them as ambiguous too. An app-level tRPC error does not
 *   settle it either: tRPC raises a 5xx-class error after the resolver returned
 *   (output validation, post-resolver middleware), so a committed write can
 *   come back as an error envelope — a mutation reports a 5xx-class tRPC error
 *   as ambiguous as well. A 4xx-class tRPC error is raised before the write
 *   (validation, authorization, not-found, precondition) and keeps the ordinary
 *   mapping. A query keeps its plain upstream error: a GET changed nothing.
 *
 * apps/web resolves identity from the forwarded bearer and the organization
 * header — both come from the verified grant props (see
 * `forwardedAuthFromProps`): the bearer is the Kilo credential bound to the
 * grant, and the organization header is the grant's organization (never a
 * caller-supplied header). Either transport keeps the same `Accept`,
 * `Authorization`, and organization headers and the same `fetchImpl ?? fetch`
 * injection.
 *
 * The caller has already validated `input` against the published schema and,
 * for a guarded row, obtained the user's approval; every rejection decidable
 * locally is thrown before any upstream request, and this helper never
 * re-decides access.
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
  if (row.kind === 'query' && sendInput) {
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
  // A mutation carries its input in the JSON body (tRPC reads a mutation from
  // POST only); a query sends it as the `?input=` param. Either way the body is
  // never empty for a mutation: `{}` is the accepted shape for a procedure that
  // takes no input, and an empty body is a 400.
  const init: RequestInit =
    row.kind === 'mutation'
      ? {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(sendInput ? input : {}),
        }
      : { method: 'GET', headers };

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), init);
  } catch {
    if (row.kind === 'mutation') {
      // The request may have reached apps/web before the connection failed, so
      // the write's outcome is unknown: say so instead of telling the agent to
      // retry blindly.
      throw ambiguousMutationFailure(path);
    }
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
    // A mutation that fails at the gateway/function layer — app.kilo.ai's
    // FUNCTION_INVOCATION_TIMEOUT 504, a 502 edge error — comes back non-2xx
    // with no tRPC error message. The POST reached the platform, so the write
    // may have landed: report it as ambiguous, like a rejected fetch, instead
    // of an ordinary upstream error that invites a blind retry.
    //
    // An app-level tRPC error is not proof the write did not land either: tRPC
    // raises a 5xx-class error AFTER the resolver returned (output validation,
    // a post-resolver middleware), so a committed mutation can still come back
    // as an error envelope. A 4xx-class tRPC error is a rejection raised before
    // the write, so it keeps the ordinary mapping. Queries are never ambiguous.
    if (row.kind === 'mutation') {
      if (hasTrpcErrorMessage(body as TrpcErrorBody | null)) {
        // The app answered: a 5xx-class error can have landed the write, so it
        // is ambiguous; a 4xx-class error was raised before the write and keeps
        // the ordinary mapping below.
        if (response.status >= 500) throw ambiguousMutationAppError(path, response.status);
      } else {
        throw ambiguousMutationFailure(path);
      }
    }
    throw toTrpcFailure(response.status, body as TrpcErrorBody, path);
  }

  const result = isTrpcSuccessBody(body) ? body.result : null;
  if (!result) {
    // A 2xx whose body cannot be read, or is not a tRPC result, says the API
    // accepted the request but not that anything failed: for a mutation the
    // write may have landed, and reporting a failure would invite a duplicate.
    if (row.kind === 'mutation') {
      throw ambiguousMutationFailure(path);
    }
    throw new JsonRpcFailure(
      INTERNAL_ERROR,
      `The Kilo API replied to "${path}" without a tRPC result body.`,
      { path }
    );
  }
  // A void procedure has no `data` key: serialize `null` so the agent gets a
  // success result instead of a false error for a write that landed.
  const data = Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null;
  return serializeWithCap(data);
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

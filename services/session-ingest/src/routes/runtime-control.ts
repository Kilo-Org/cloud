import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

import {
  createAndRunLocalSessionRequestSchema,
  getLocalRuntimeCatalogRequestSchema,
  localRuntimeCatalogResponseSchema,
  localRuntimeControlErrorCodeSchema,
  localRuntimeCreateResponseSchema,
  localRuntimeErrorResponseSchema,
  localRuntimeFenceSchema,
  localRuntimeListResponseSchema,
  type CreateAndRunLocalSessionResult,
  type LocalRuntimeCatalog,
  type LocalRuntimeControlErrorCode,
} from '@kilocode/session-ingest-contracts';

import type { Env } from '../env';
import { getUserConnectionDO } from '../dos/UserConnectionDO';

const CATALOG_MAX_BODY_BYTES = 64 * 1024;
const CREATE_AND_RUN_MAX_BODY_BYTES = 64 * 1024;

type ApiContext = {
  Bindings: Env;
  Variables: {
    user_id: string;
  };
};

export const runtimeControlApi = new Hono<ApiContext>();

/**
 * Safe, fixed-message envelopes for every supported upstream error code. The
 * relay never re-emits the raw DO error message — mobile branches on `code`
 * and the human-readable text is operator-facing only.
 */
const SAFE_ERROR_MESSAGES: Record<LocalRuntimeControlErrorCode, string> = {
  RUNTIME_NOT_CONNECTED: 'Runtime is not currently connected',
  RUNTIME_FENCE_MISMATCH: 'Runtime control request rejected',
  CLI_UPGRADE_REQUIRED: 'CLI upgrade required',
  CATALOG_CHANGED: 'Catalog request rejected',
  COMMAND_ALREADY_PENDING: 'Runtime control request rejected',
  PENDING_COMMAND_LIMIT: 'Too many pending commands',
  COMMAND_EXPIRED: 'Runtime control request expired',
  RESULT_TOO_LARGE: 'Internal error',
  INVALID_RUNTIME_RESPONSE: 'Internal error',
  RUNTIME_COMMAND_FAILED: 'Internal error',
  COMMAND_NOT_ALLOWED: 'Command not allowed',
};

/**
 * Map a `LocalRuntimeControlErrorCode` to the HTTP status mobile should
 * recover from. The status is a recovery hint, never a leak.
 */
const ERROR_STATUS: Record<LocalRuntimeControlErrorCode, number> = {
  RUNTIME_NOT_CONNECTED: 404,
  RUNTIME_FENCE_MISMATCH: 409,
  CLI_UPGRADE_REQUIRED: 412,
  CATALOG_CHANGED: 409,
  COMMAND_ALREADY_PENDING: 409,
  PENDING_COMMAND_LIMIT: 429,
  COMMAND_EXPIRED: 504,
  RESULT_TOO_LARGE: 500,
  INVALID_RUNTIME_RESPONSE: 500,
  RUNTIME_COMMAND_FAILED: 500,
  COMMAND_NOT_ALLOWED: 403,
};

function safeErrorEnvelope(code: LocalRuntimeControlErrorCode) {
  return localRuntimeErrorResponseSchema.parse({
    error: {
      source: 'relay' as const,
      code,
      message: SAFE_ERROR_MESSAGES[code],
    },
  });
}

function internalErrorEnvelope() {
  return {
    error: {
      source: 'relay' as const,
      code: 'INTERNAL' as const,
      message: 'Internal error',
    },
  };
}

function isLocalRuntimeCommandError(err: unknown): err is { code: LocalRuntimeControlErrorCode } {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown };
  if (candidate.name !== 'LocalRuntimeCommandError') return false;
  // Validate against the contract's strict enum so a poisoned/missing code
  // is treated as a non-typed error and collapses to the safe 500 envelope.
  return localRuntimeControlErrorCodeSchema.safeParse(candidate.code).success;
}

/**
 * Read-only runtime list for the bound user. The user identity comes solely
 * from the auth middleware's signed payload — never from the request — and
 * the response is shape-validated against the cross-service contract before
 * leaving the worker. Any upstream or schema failure collapses to a generic
 * 500; the raw DO/parser error is never propagated to the client or logged
 * alongside the token.
 */
runtimeControlApi.get('/runtimes', async c => {
  const kiloUserId = c.get('user_id');
  try {
    const stub = getUserConnectionDO(c.env, { kiloUserId });
    const runtimes = await stub.getRuntimePresence();
    const payload = localRuntimeListResponseSchema.parse({ runtimes });
    return c.json(payload, 200);
  } catch (err) {
    if (err instanceof ZodError) {
      // The DO is required to satisfy the contract; an unexpected shape
      // indicates a wire-level bug and is not the client's problem to debug.
      console.error('[runtime-control] DO returned an unexpected runtime shape');
    } else {
      console.error('[runtime-control] runtime list fetch failed');
    }
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

/**
 * Relay the catalog request to the user's UserConnectionDO using the
 * audience-bound fence. The DO performs all authoritative validation; this
 * handler is a thin transport that:
 *   - rejects oversized bodies with 413 before any parsing;
 *   - strict-parses the body into `{ fence, request }` and rejects extras;
 *   - maps stable `LocalRuntimeCommandError` codes to safe HTTP statuses;
 *   - never logs the token, body, raw DO error, or catalog content.
 */
runtimeControlApi.post('/catalog', async c => {
  const contentLengthHeader = c.req.header('content-length');
  if (contentLengthHeader !== undefined) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > CATALOG_MAX_BODY_BYTES) {
      return c.json({ success: false, error: 'payload_too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > CATALOG_MAX_BODY_BYTES) {
    return c.json({ success: false, error: 'payload_too_large' }, 413);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return c.json({ success: false, error: 'invalid_json' }, 400);
  }

  const fenceParsed = localRuntimeFenceSchema.safeParse(
    (parsedJson as { fence?: unknown } | null)?.fence
  );
  const requestParsed = getLocalRuntimeCatalogRequestSchema.safeParse(
    (parsedJson as { request?: unknown } | null)?.request
  );
  if (!fenceParsed.success || !requestParsed.success) {
    return c.json({ success: false, error: 'invalid_body' }, 400);
  }

  // Reject extra top-level fields beyond the strict `{fence, request}` shape.
  const keys = Object.keys(parsedJson as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes('fence') || !keys.includes('request')) {
    return c.json({ success: false, error: 'invalid_body' }, 400);
  }

  const kiloUserId = c.get('user_id');
  try {
    const stub = getUserConnectionDO(c.env, { kiloUserId });
    const catalog = await (stub.getRuntimeCatalog(fenceParsed.data) as Promise<LocalRuntimeCatalog>);
    const response = localRuntimeCatalogResponseSchema.parse({ catalog });
    return c.json(response, 200);
  } catch (err) {
    if (isLocalRuntimeCommandError(err)) {
      const code = err.code;
      return c.json(safeErrorEnvelope(code), ERROR_STATUS[code] as ContentfulStatusCode);
    }
    console.error('[runtime-control] catalog fetch failed');
    return c.json(internalErrorEnvelope(), 500);
  }
});

/**
 * Relay the create-and-run request to the user's UserConnectionDO. This
 * handler is a thin transport that:
 *   - rejects oversized bodies with 413 before any parsing;
 *   - strict-parses the body into `{ fence, request }` and rejects extras;
 *   - maps stable `LocalRuntimeCommandError` codes to safe HTTP statuses;
 *   - never logs the token, body, raw DO error, or result content.
 *
 * The DO is the only caller of the CLI; the handler awaits the
 * response-dependent RPC and returns the strict `{result}` envelope. The
 * server-side readiness wait against `cli_sessions_v2` is owned by the
 * `localRuntimeControl.createAndRun` tRPC mutation, not by this route.
 */
runtimeControlApi.post('/create-and-run', async c => {
  const contentLengthHeader = c.req.header('content-length');
  if (contentLengthHeader !== undefined) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > CREATE_AND_RUN_MAX_BODY_BYTES) {
      return c.json({ success: false, error: 'payload_too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > CREATE_AND_RUN_MAX_BODY_BYTES) {
    return c.json({ success: false, error: 'payload_too_large' }, 413);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return c.json({ success: false, error: 'invalid_json' }, 400);
  }

  const fenceParsed = localRuntimeFenceSchema.safeParse(
    (parsedJson as { fence?: unknown } | null)?.fence
  );
  const requestParsed = createAndRunLocalSessionRequestSchema.safeParse(
    (parsedJson as { request?: unknown } | null)?.request
  );
  if (!fenceParsed.success || !requestParsed.success) {
    return c.json({ success: false, error: 'invalid_body' }, 400);
  }

  // Reject extra top-level fields beyond the strict `{fence, request}` shape.
  const keys = Object.keys(parsedJson as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes('fence') || !keys.includes('request')) {
    return c.json({ success: false, error: 'invalid_body' }, 400);
  }

  const kiloUserId = c.get('user_id');
  try {
    const stub = getUserConnectionDO(c.env, { kiloUserId });
    const result = await (stub.createAndRunLocalSession(
      fenceParsed.data,
      requestParsed.data
    ) as Promise<CreateAndRunLocalSessionResult>);
    const response = localRuntimeCreateResponseSchema.parse({ result });
    return c.json(response, 200);
  } catch (err) {
    if (isLocalRuntimeCommandError(err)) {
      const code = err.code;
      return c.json(safeErrorEnvelope(code), ERROR_STATUS[code] as ContentfulStatusCode);
    }
    console.error('[runtime-control] create-and-run failed');
    return c.json(internalErrorEnvelope(), 500);
  }
});

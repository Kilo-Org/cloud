import 'server-only';

import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';
import {
  getLocalRuntimeCatalogRequestSchema,
  localRuntimeCatalogResponseSchema,
  localRuntimeControlErrorCodeSchema,
  localRuntimeErrorResponseSchema,
  localRuntimeFenceSchema,
  localRuntimeListResponseSchema,
  SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE,
  type LocalRuntimeFence,
  type LocalRuntimeListResponse,
} from '@kilocode/session-ingest-contracts';
import { remoteModelCatalogV1Schema, type RemoteModelCatalogV1 } from '@/lib/cloud-agent-sdk/schemas';

const RUNTIME_LIST_TIMEOUT_MS = 5_000;
const RUNTIME_CATALOG_TIMEOUT_MS = 5_000;

export class LocalRuntimeControlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalRuntimeControlRequestError';
  }
}

/**
 * Typed error raised by `LocalRuntimeControlClient.getCatalog` when the relay
 * returns a structured error envelope. The `upstreamCode` is the stable
 * `LocalRuntimeControlErrorCode` and is exposed to the mobile client as
 * `error.data.upstreamCode` so the recovery branch can be chosen in-app.
 */
export class LocalRuntimeCatalogError extends Error {
  constructor(
    public readonly upstreamCode: string,
    message: string
  ) {
    super(message);
    this.name = 'LocalRuntimeCatalogError';
  }
}

export type LocalRuntimeList = LocalRuntimeListResponse;

export type LocalRuntimeCatalog = {
  protocolVersion: 1;
  models: RemoteModelCatalogV1;
  agents: Array<{ slug: string; name: string; description?: string; model?: unknown; variant?: string }>;
  defaultAgent: string;
};

export type LocalRuntimeCatalogResponse = { catalog: LocalRuntimeCatalog };

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new LocalRuntimeControlRequestError('Local runtime list response was not valid JSON');
  }
}

function buildAudienceToken(userId: string): string {
  return generateInternalServiceToken(userId, {
    expiresIn: TOKEN_EXPIRY.fiveMinutes,
    audience: SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE,
  });
}

export const LocalRuntimeControlClient = {
  /**
   * Fetch the read-only runtime list for the bound user from the
   * session-ingest service. The five-minute, audience-bound internal token
   * proves the caller is acting on behalf of that user; the service mirrors
   * the audience check and resolves the user DO from the signed payload
   * alone.
   *
   * Any network failure, non-2xx response, or shape mismatch throws a
   * `LocalRuntimeControlRequestError`. Failures are NEVER downgraded to an
   * empty list — the caller decides the recovery state from the typed error.
   */
  async list(userId: string): Promise<LocalRuntimeList> {
    if (!SESSION_INGEST_WORKER_URL) {
      throw new LocalRuntimeControlRequestError('Session ingest worker URL is not configured');
    }

    const token = buildAudienceToken(userId);

    let response: Response;
    try {
      response = await fetch(
        `${SESSION_INGEST_WORKER_URL}/internal/runtime-control/runtimes`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(RUNTIME_LIST_TIMEOUT_MS),
        }
      );
    } catch {
      throw new LocalRuntimeControlRequestError('Local runtime list request failed');
    }

    if (!response.ok) {
      throw new LocalRuntimeControlRequestError(
        `Local runtime list request failed (${response.status})`
      );
    }

    const parsed = localRuntimeListResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) {
      throw new LocalRuntimeControlRequestError('Local runtime list response was malformed');
    }

    return parsed.data;
  },

  /**
   * Fetch the model catalog for a specific runtime fence. The fence is the
   * exact (runtimeId, connectionId) pair mobile resolved from the runtime
   * list; the relay validates that the fence still matches the live socket
   * and routes the catalog command to that exact socket. The response
   * `catalog.models` is the canonical wire catalog from the CLI, parsed
   * through the existing `remoteModelCatalogV1Schema` so the shape mobile
   * receives matches every other remote-model surface in the web app.
   *
   * Failures collapse to `LocalRuntimeCatalogError` with a stable
   * `upstreamCode` (always one of the
   * `LocalRuntimeControlErrorCode` values, or `UNKNOWN` for an
   * unparseable envelope). The caller MUST branch on `upstreamCode` to
   * choose the recovery flow.
   */
  async getCatalog(userId: string, fence: LocalRuntimeFence): Promise<LocalRuntimeCatalogResponse> {
    if (!SESSION_INGEST_WORKER_URL) {
      throw new LocalRuntimeCatalogError('UNKNOWN', 'Session ingest worker URL is not configured');
    }

    const token = buildAudienceToken(userId);

    const body = JSON.stringify({
      fence: localRuntimeFenceSchema.parse(fence),
      request: getLocalRuntimeCatalogRequestSchema.parse({ protocolVersion: 1 }),
    });

    let response: Response;
    try {
      response = await fetch(
        `${SESSION_INGEST_WORKER_URL}/internal/runtime-control/catalog`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(RUNTIME_CATALOG_TIMEOUT_MS),
        }
      );
    } catch {
      throw new LocalRuntimeCatalogError('UNKNOWN', 'Local runtime catalog request failed');
    }

    if (!response.ok) {
      // Attempt to extract a structured upstream code from the body without
      // surfacing any other content. A non-2xx with a parseable envelope
      // becomes a typed error; otherwise we fall back to UNKNOWN.
      const raw = await response.text().catch(() => '');
      let upstreamCode = 'UNKNOWN';
      try {
        const envelope = localRuntimeErrorResponseSchema.safeParse(JSON.parse(raw));
        if (envelope.success) {
          const codeParse = localRuntimeControlErrorCodeSchema.safeParse(
            envelope.data.error.code
          );
          if (codeParse.success) upstreamCode = codeParse.data;
        }
      } catch {
        // ignore — the body was not JSON; keep UNKNOWN
      }
      throw new LocalRuntimeCatalogError(
        upstreamCode,
        `Local runtime catalog request failed (${response.status})`
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(await response.text());
    } catch {
      throw new LocalRuntimeCatalogError('UNKNOWN', 'Local runtime catalog response was not valid JSON');
    }

    const envelope = localRuntimeCatalogResponseSchema.safeParse(parsedBody);
    if (!envelope.success) {
      // The envelope failed strict validation; the upstream returned a
      // malformed body, not a structured error. Surface as INVALID_RUNTIME_RESPONSE
      // if the body has a recognizable error code, otherwise UNKNOWN.
      const fallback = localRuntimeErrorResponseSchema.safeParse(parsedBody);
      if (fallback.success) {
        throw new LocalRuntimeCatalogError(
          fallback.data.error.code,
          fallback.data.error.message
        );
      }
      throw new LocalRuntimeCatalogError(
        'UNKNOWN',
        'Local runtime catalog response was malformed'
      );
    }

    const modelsParse = remoteModelCatalogV1Schema.safeParse(envelope.data.catalog.models);
    if (!modelsParse.success) {
      throw new LocalRuntimeCatalogError(
        'INVALID_RUNTIME_RESPONSE',
        'Local runtime catalog models failed strict validation'
      );
    }

    return {
      catalog: {
        protocolVersion: 1,
        models: modelsParse.data,
        agents: envelope.data.catalog.agents,
        defaultAgent: envelope.data.catalog.defaultAgent,
      },
    };
  },
};

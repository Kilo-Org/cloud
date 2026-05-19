import { z } from 'zod';

// ── Wasteland tRPC response schemas (mirrored from services/wasteland) ──
// These define the wire types for Wasteland's tRPC API. They are intentionally
// duplicated here to avoid a cross-package import and to validate at the IO
// boundary per project conventions.

export const WantedItemOutput = z.object({
  item_id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['open', 'claimed', 'done']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  type: z.enum(['feature', 'bug', 'docs', 'other']),
  claimed_by: z.string().nullable(),
  evidence: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const WastelandOutput = z.object({
  wasteland_id: z.string(),
  name: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_user_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  dolthub_upstream: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  status: z.enum(['active', 'deleted']),
  created_at: z.string(),
  updated_at: z.string(),
});

export const WastelandMemberOutput = z.object({
  member_id: z.string(),
  user_id: z.string(),
  trust_level: z.number(),
  role: z.enum(['contributor', 'maintainer', 'owner']),
  joined_at: z.string(),
});

export const ConnectedTownOutput = z.object({
  town_id: z.string(),
  wasteland_id: z.string(),
  connected_by: z.string(),
  connected_at: z.string(),
});

export type WantedItem = z.infer<typeof WantedItemOutput>;
export type Wasteland = z.infer<typeof WastelandOutput>;
export type WastelandMember = z.infer<typeof WastelandMemberOutput>;
export type ConnectedTown = z.infer<typeof ConnectedTownOutput>;

// ── tRPC wire format schemas ────────────────────────────────────────────
// tRPC wraps successful responses in { result: { data: T } } and errors
// in { error: { message, code, data? } }.

const TrpcSuccessEnvelope = z.object({
  result: z.object({ data: z.unknown() }),
});

const TrpcErrorEnvelope = z.object({
  error: z.object({
    message: z.string(),
    code: z.number(),
    data: z.unknown().optional(),
  }),
});

// ── Error types ─────────────────────────────────────────────────────────

export class WastelandClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'WastelandClientError';
  }
}

// ── Client factory ──────────────────────────────────────────────────────

type WastelandClientDeps = {
  /** Cloudflare service binding — preferred (zero-network-hop in production). */
  wastelandService?: Fetcher;
  /** Fallback HTTP URL when service binding is unavailable (e.g. local dev). */
  wastelandApiUrl?: string;
  /** The user's Kilo JWT to forward for authentication. */
  authToken: string;
};

/**
 * Low-level helper that sends a request to the Wasteland tRPC API, either
 * via the Cloudflare service binding or falling back to an HTTP URL.
 *
 * Service bindings use `Fetcher.fetch()` which requires a full URL — we use
 * a synthetic `https://wasteland-service/` origin that the binding ignores
 * (only the path matters).
 */
async function trpcFetch(
  deps: WastelandClientDeps,
  path: string,
  init: RequestInit
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${deps.authToken}`);
  headers.set('Content-Type', 'application/json');

  // Prefer the service binding when available (zero-network-hop in prod).
  if (deps.wastelandService) {
    const bindingUrl = `https://wasteland-service${path}`;
    try {
      const response = await deps.wastelandService.fetch(
        new Request(bindingUrl, { ...init, headers })
      );
      // In local wrangler dev, a bound service that isn't actually running
      // returns 503. Fall back to HTTP so dev works without a service
      // registry. Only fall back on upstream-unavailable codes, not on
      // application-level errors.
      if (response.status !== 503 || !deps.wastelandApiUrl) {
        return response;
      }
      console.warn('[wasteland-client] service binding returned 503, falling back to HTTP', {
        wastelandApiUrl: deps.wastelandApiUrl,
      });
    } catch (err) {
      if (!deps.wastelandApiUrl) throw err;
      console.warn('[wasteland-client] service binding threw, falling back to HTTP', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deps.wastelandApiUrl) {
    const httpUrl = `${deps.wastelandApiUrl}${path}`;
    return fetch(new Request(httpUrl, { ...init, headers }));
  }

  throw new WastelandClientError(
    'No Wasteland service binding or API URL configured',
    'CONFIG_ERROR',
    500
  );
}

/** Parse a tRPC JSON response, validating the envelope and extracting data. */
async function parseTrpcResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    let errorMessage = `Wasteland service returned ${response.status}`;
    try {
      const body: unknown = await response.json();
      const parsed = TrpcErrorEnvelope.safeParse(body);
      if (parsed.success) {
        errorMessage = parsed.data.error.message;
        throw new WastelandClientError(
          errorMessage,
          String(parsed.data.error.code),
          response.status,
          parsed.data.error.data
        );
      }
    } catch (err) {
      if (err instanceof WastelandClientError) throw err;
      // JSON parse failed — use the generic message
    }
    throw new WastelandClientError(errorMessage, 'HTTP_ERROR', response.status);
  }

  const body: unknown = await response.json();
  const envelope = TrpcSuccessEnvelope.parse(body);
  return schema.parse(envelope.result.data);
}

/** Send a tRPC query (GET). */
async function trpcQuery<T>(
  deps: WastelandClientDeps,
  procedure: string,
  input: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  const encodedInput = encodeURIComponent(JSON.stringify({ json: input }));
  const path = `/trpc/wasteland.${procedure}?input=${encodedInput}`;
  const response = await trpcFetch(deps, path, { method: 'GET' });
  return parseTrpcResponse(response, schema);
}

/** Send a tRPC mutation (POST). */
async function trpcMutation<T>(
  deps: WastelandClientDeps,
  procedure: string,
  input: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  const path = `/trpc/wasteland.${procedure}`;
  const response = await trpcFetch(deps, path, {
    method: 'POST',
    body: JSON.stringify({ json: input }),
  });
  return parseTrpcResponse(response, schema);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Creates a typed Wasteland client that communicates with the Wasteland
 * service via Cloudflare service binding (preferred) or HTTP fallback.
 *
 * The caller must provide the user's auth token — the same Kilo JWT that
 * authenticated the inbound Gastown request — which is forwarded to
 * Wasteland for user identification.
 *
 * @example
 * ```ts
 * const header = c.req.header('Authorization') ?? '';
 * const authToken = header.startsWith('Bearer ') ? header.slice(7) : '';
 *
 * const client = createWastelandClient({
 *   wastelandService: env.WASTELAND_SERVICE,
 *   wastelandApiUrl: env.WASTELAND_API_URL,
 *   authToken,
 * });
 * const items = await client.browseWantedBoard({ wastelandId });
 * ```
 */
export function createWastelandClient(deps: WastelandClientDeps) {
  return {
    // ── Wanted Board ──────────────────────────────────────────────

    browseWantedBoard(input: { wastelandId: string }) {
      return trpcQuery(deps, 'browseWantedBoard', input, WantedItemOutput.array());
    },

    claimWantedItem(input: { wastelandId: string; itemId: string }) {
      return trpcMutation(deps, 'claimWantedItem', input, z.object({ success: z.boolean() }));
    },

    postWantedItem(input: {
      wastelandId: string;
      title: string;
      description: string;
      priority?: string;
      type?: string;
      publish?: boolean;
    }) {
      return trpcMutation(
        deps,
        'postWantedItem',
        input,
        z.object({ success: z.boolean(), wantedId: z.string(), pr_url: z.string().nullable() })
      );
    },

    markWantedItemDone(input: { wastelandId: string; itemId: string; evidence: string }) {
      return trpcMutation(
        deps,
        'markWantedItemDone',
        input,
        z.object({ success: z.boolean(), pr_url: z.string().nullable() })
      );
    },

    // ── Wasteland CRUD ────────────────────────────────────────────

    listWastelands(input: { organizationId?: string } = {}) {
      return trpcQuery(deps, 'listWastelands', input, WastelandOutput.array());
    },

    getWasteland(input: { wastelandId: string }) {
      return trpcQuery(deps, 'getWasteland', input, WastelandOutput);
    },

    // ── Members ───────────────────────────────────────────────────

    listMembers(input: { wastelandId: string }) {
      return trpcQuery(deps, 'listMembers', input, WastelandMemberOutput.array());
    },

    // ── Connected Towns ─────────────────────────────────────────

    connectKiloTown(input: { wastelandId: string; townId: string }) {
      return trpcMutation(deps, 'connectKiloTown', input, ConnectedTownOutput);
    },

    disconnectKiloTown(input: { wastelandId: string; townId: string }) {
      return trpcMutation(deps, 'disconnectKiloTown', input, z.object({ success: z.boolean() }));
    },

    listConnectedTowns(input: { wastelandId: string }) {
      return trpcQuery(deps, 'listConnectedTowns', input, ConnectedTownOutput.array());
    },
  };
}

export type WastelandClient = ReturnType<typeof createWastelandClient>;

/**
 * Shared types for the kilo-mcp worker. The catalog is dumped and committed by
 * apps/web/src/scripts/mcp-catalog (see dump.ts); this slice bundles it as a
 * static artifact (`import catalog from '../catalog.json'`).
 */

/**
 * One published tRPC procedure, as recorded in services/kilo-mcp/catalog.json.
 * `kind` is the procedure's own kind: a `query` reads data, a `mutation`
 * changes it. The transport, and what a failure means, differ per kind.
 */
export type CatalogRow = {
  path: string;
  kind: 'query' | 'mutation';
  summary: string;
  /** Published JSON Schema (draft 2020-12) of the procedure input, `{}` when it takes none. */
  inputSchema: Record<string, unknown>;
  tags: string[];
  searchBlob: string;
  /**
   * Set by the catalog dump only on rows whose tRPC procedure sits behind
   * `adminProcedure` (or a guard derived from it); absent means the row is
   * available to every grant.
   */
  admin?: true;
  /**
   * Set by the catalog dump only on rows from the `debug` router; absent means
   * the row is available to every grant. A row is *guarded* when either this or
   * `admin` is present (`isGuardedRow` in src/search.ts).
   */
  debug?: true;
};

/** The whole catalog: keyed by procedure path. */
export type Catalog = Record<string, CatalogRow>;

/**
 * The per-grant props the OAuth provider library decrypts into `ctx.props` for
 * a verified MCP access token. `completeAuthorization` stores
 * `{ kiloUserId, organizationId, kiloToken }` (src/oauth/consent.ts) and the
 * client id is added alongside them, so the API handler can forward the Kilo
 * credential without re-verifying anything.
 */
export type GrantProps = {
  kiloUserId: string;
  organizationId: string | null;
  kiloToken: string;
  clientId: string;
  /**
   * Admin opt-in from the consent checkbox. Optional and fail-closed: grants
   * issued before this feature carry no such key, so `undefined` stays disabled.
   */
  adminEnabled?: boolean;
  /**
   * Whether the grant's owner was an admin when the grant was minted. Optional
   * and fail-closed: absent means no, so a pre-feature grant is never eligible
   * and never sees an admin or debug trace.
   */
  adminEligible?: boolean;
  /**
   * The grant's own connection identity. A protected request is bound to the
   * session that created it, so another session can never submit its OTP.
   * Optional and fail-closed: absent or empty means "not this connection".
   */
  sessionId?: string;
};

/**
 * Credentials forwarded to apps/web; derived entirely from the verified grant
 * props. apps/web resolves identity and org membership.
 */
export type ForwardedAuth = {
  /**
   * The raw `Authorization` header value to pass through: the Kilo API token
   * bound to the verified grant. A caller-supplied bearer is never consulted —
   * the library authenticated the request before the API handler runs.
   */
  authorization: string;
  /** Organization from the grant props (never a caller-supplied header). */
  organizationId?: string;
  /** The Kilo user the grant is bound to (analytics identity). */
  kiloUserId: string;
  /** OAuth client the grant was issued to. */
  clientId: string;
  /**
   * Whether the grant opted into admin procedures. Optional and fail-closed:
   * a pre-feature grant carries no such key, and `undefined` stays disabled.
   */
  adminEnabled?: boolean;
  /**
   * Whether the grant's owner is an admin, forwarded so the handler can name
   * the hidden endpoints in an empty search answer. Optional and fail-closed:
   * absent means no.
   */
  adminEligible?: boolean;
  /**
   * The grant's connection identity, forwarded so `call_protected` can bind a
   * pending request to it and `submit_otp` can refuse another session's id.
   * Optional and fail-closed: absent or empty means "not this connection".
   */
  sessionId?: string;
};

/** A search hit returned by the search tool. */
export type SearchResult = {
  path: string;
  kind: CatalogRow['kind'];
  summary: string;
  tags: string[];
  score: number;
  /**
   * Present on a guarded row (admin or debug) that the connection may see: the
   * model must get the user's approval before the call runs.
   */
  requiresApproval?: true;
  /**
   * The endpoint's published input schema, byte-identical to the catalog row —
   * exactly what `call` validates an input against.
   */
  inputSchema: Record<string, unknown>;
};

/**
 * A guarded MCP procedure is either admin-only or a debug endpoint; the
 * protected-request store and the admin tools share one definition.
 */
export type ProtectedRequestKind = 'admin' | 'debug';

/**
 * The outcome of `submit_otp`. `not_pending` is the single uniform refusal for
 * an unknown id, another session's id and an already-used request — it names
 * nothing, so enumerating ids learns nothing. `bad_code` carries the attempts
 * remaining, `reused_code` refuses a code from a step already accepted, and
 * `no_authenticator` means the admin never finished enrollment. `locked` is the
 * account-wide wrong-code limit: it is scoped to the authenticator, so minting
 * a fresh `call_protected` request cannot reset it, and it carries how long the
 * caller must wait before trying again.
 */
export type OtpSubmitOutcome =
  | { status: 'ok'; path: string; inputJson: string | null }
  | { status: 'not_pending' }
  | { status: 'expired' }
  | { status: 'invalidated' }
  | { status: 'bad_code'; attemptsRemaining: number }
  | { status: 'reused_code' }
  | { status: 'no_authenticator' }
  | { status: 'locked'; retryAfterSeconds: number };

/**
 * The protected-request surface the `call_protected` and `submit_otp` tools
 * depend on. The DurableObjectStub of KiloMcpOAuthStore satisfies it
 * structurally; tests pass an in-memory fake. The caller always supplies
 * `nowIso` so the decision never reads the clock.
 */
export type ProtectedRequestsApi = {
  /** Record a reviewed guarded call; return its id and its expiry. */
  createProtectedRequest(input: {
    sessionId: string;
    kiloUserId: string;
    clientId: string;
    path: string;
    kind: ProtectedRequestKind;
    inputJson: string | null;
    nowIso: string;
  }): Promise<{ id: string; expiresAt: string }>;
  /**
   * Whether `sessionId` can still submit `id`, and if not, why — without
   * consuming anything. An unknown id, another session's id and a used row
   * answer `gone`, so the caller's reply for those is uniform; the owning
   * connection, which already holds the id, gets the specific `expired` or
   * `invalidated` state so its refusal can name the reason. `locked` reports
   * the owner's account-wide wrong-code lockout, which no fresh request resets.
   */
  peekProtectedRequest(
    id: string,
    sessionId: string,
    nowIso: string
  ): Promise<
    | { status: 'pending' }
    | { status: 'expired' }
    | { status: 'invalidated' }
    | { status: 'gone' }
    | { status: 'locked'; retryAfterSeconds: number }
  >;
  /**
   * Verify the submitted code against the owner's authenticator and, on
   * success, claim the request exactly once — all in one storage transaction.
   */
  verifyOtpAndClaim(input: {
    id: string;
    sessionId: string;
    kiloUserId: string;
    code: string;
    nowIso: string;
  }): Promise<OtpSubmitOutcome>;
};

/**
 * The authenticator enrollment surface the org picker depends on. The
 * DurableObjectStub of KiloMcpOAuthStore satisfies it structurally.
 */
export type AuthenticatorEnrollmentApi = {
  /**
   * The admin's authenticator, created on first call. Every later call returns
   * the SAME secret (a picker re-render must never invalidate the secret the
   * admin already scanned) plus whether a code has verified against it.
   */
  ensureAuthenticator(
    kiloUserId: string,
    nowIso: string
  ): Promise<{ secret: string; verified: boolean }>;
  /**
   * Verify an enrollment code against the stored secret and mark the
   * authenticator verified; false when the code does not match.
   */
  confirmAuthenticator(kiloUserId: string, code: string, nowIso: string): Promise<boolean>;
};

/**
 * Injectable Vectorize kNN hook (filled by s3). Returns extra candidates with
 * semantic scores keyed by catalog path; defaults to none.
 */
export type SemanticCandidates = (
  query: string,
  limit: number
) => Promise<Array<{ path: string; score: number }>>;

/** Error whose fields map onto a JSON-RPC error response. */
export class JsonRpcFailure extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'JsonRpcFailure';
    this.code = code;
    this.data = data;
  }
}

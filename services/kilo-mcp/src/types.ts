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
};

/** A search hit returned by the search tool. */
export type SearchResult = {
  path: string;
  kind: CatalogRow['kind'];
  summary: string;
  tags: string[];
  score: number;
  /**
   * The endpoint's published input schema, byte-identical to the catalog row —
   * exactly what `call` validates an input against.
   */
  inputSchema: Record<string, unknown>;
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

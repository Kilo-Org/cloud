/**
 * Shared types for the kilo-mcp worker. The catalog is dumped and committed by
 * apps/web/src/scripts/mcp-catalog (see dump.ts); this slice bundles it as a
 * static artifact (`import catalog from '../catalog.json'`).
 */

/** One published tRPC query, as recorded in services/kilo-mcp/catalog.json. */
export type CatalogRow = {
  path: string;
  kind: 'query';
  summary: string;
  /** Published JSON Schema (draft 2020-12) of the procedure input, `{}` when it takes none. */
  inputSchema: Record<string, unknown>;
  tags: string[];
  searchBlob: string;
};

/** The whole catalog: keyed by procedure path. */
export type Catalog = Record<string, CatalogRow>;

/** Credentials forwarded to apps/web; apps/web resolves identity and org membership. */
export type ForwardedAuth = {
  /**
   * The raw `Authorization` header value to pass through. With s6
   * enforcement this is the Kilo API token behind the verified MCP token
   * (apps/web cannot verify the worker's own JWT); only the unconfigured-
   * worker passthrough and tests carry a caller-supplied bearer.
   */
  authorization: string;
  /**
   * Value of the organization header. With a verified MCP token this is the
   * token's org claim — a caller-supplied header is never consulted.
   */
  organizationId?: string;
  /**
   * Set when the bearer was verified as an MCP access token issued by this
   * worker: the identity the token is bound to (s6).
   */
  mcpIdentity?: {
    kiloUserId: string;
    organizationId: string | null;
    clientId: string;
    expiresAt: number;
  };
};

/** A search hit returned by the search tool. */
export type SearchResult = {
  path: string;
  kind: CatalogRow['kind'];
  summary: string;
  tags: string[];
  score: number;
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

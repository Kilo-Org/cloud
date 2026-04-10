/**
 * Env bindings for the kilo-context-pipeline Worker.
 * Keep in sync with wrangler.jsonc.
 */
export interface Env {
  // ── Durable Objects ──────────────────────────────────────────────────────
  /** Manages run lifecycle, SQLite history, and fan-out to Containers. */
  PIPELINE_ORCHESTRATOR: DurableObjectNamespace;
  /** One Container instance per pipeline run. */
  PIPELINE_CONTAINER: DurableObjectNamespace;

  // ── Service binding ───────────────────────────────────────────────────────
  /** The kilo-context MCP Worker — called for /_invalidate after a successful run. */
  KB_WORKER: Fetcher;

  // ── Instance identity ─────────────────────────────────────────────────────
  /**
   * Stable ID for this KB instance (default: "kilo-internal").
   * Used as the DO name for PIPELINE_ORCHESTRATOR so run history is persistent
   * across Worker deployments.
   */
  PIPELINE_INSTANCE_ID: string;

  // ── Pipeline secrets (injected into the Container subprocess env) ─────────
  // All are passed verbatim to `npm run pull` / `npm run update` inside the
  // Container. The pipeline scripts read them via process.env.

  /** Kilo gateway token — used by run-all.mjs for LLM API calls. */
  KILO_API_TOKEN: string;
  /** Kilo org ID — passed alongside KILO_API_TOKEN for gateway auth. */
  KILO_ORG_ID: string;
  /** Slack user token — used by fetch-sources.mjs to pull Slack transcripts. */
  SLACK_USER_TOKEN: string;
  /** R2 access key — used by publish.mjs to upload KB artifacts. */
  R2_ACCESS_KEY_ID: string;
  /** R2 secret key — used by publish.mjs to upload KB artifacts. */
  R2_SECRET_ACCESS_KEY: string;
  /**
   * Shared secret between this service and the KB Worker.
   * The Orchestrator sends this as X-Pipeline-Token when calling /_invalidate.
   * The KB Worker accepts it without requiring MCP_AUTH_TOKEN.
   */
  PIPELINE_SERVICE_TOKEN: string;

  // ── Optional secrets ──────────────────────────────────────────────────────
  /**
   * Google Drive folder ID. If set, the transcripts connector runs.
   * Also set GDRIVE_TOKEN_JSON (base64 pre-staged token.json).
   * If unset, pull-transcripts.mjs is skipped entirely.
   */
  GDRIVE_FOLDER_ID?: string;
  /**
   * Base64-encoded Google Drive token.json. Injected as GDRIVE_TOKEN_JSON.
   * The transcripts connector reads it and writes to $KB_ROOT/token.json.
   * Required if GDRIVE_FOLDER_ID is set.
   */
  GDRIVE_TOKEN_JSON?: string;
}

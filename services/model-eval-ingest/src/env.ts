/**
 * Runtime bindings — mirrors what wrangler.jsonc declares.
 *
 * We write these types by hand rather than relying on the auto-generated
 * `Cloudflare.Env` (which requires running `wrangler types` and lands a
 * committed worker-configuration.d.ts). The binding surface here is
 * small and stable — a Hyperdrive connection and one Secrets Store
 * binding — so maintaining it inline is cheaper than the generator
 * dance.
 */
export type Env = {
  /** Hyperdrive binding pointing at the main cloud Postgres. */
  HYPERDRIVE: {
    connectionString: string;
  };
  /** HMAC secret shared with the bench.s1lv.com service. */
  MODEL_EVAL_INGEST_SECRET: {
    get(): Promise<string | null>;
  };
  /** "production" | "development" — set via wrangler.jsonc vars. */
  ENVIRONMENT: 'production' | 'development';
};

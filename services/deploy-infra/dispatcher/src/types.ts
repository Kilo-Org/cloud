/**
 * Environment type for the dispatcher worker.
 * Extends CloudflareEnv (auto-generated from wrangler.jsonc bindings)
 * with secrets that are set via .dev.vars or Cloudflare dashboard.
 */
export interface Env extends CloudflareEnv {
  // Secrets not in wrangler.jsonc - set via .dev.vars or dashboard
  JWT_SECRET: string;
  BACKEND_AUTH_TOKEN: string;
}

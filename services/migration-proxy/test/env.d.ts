import type { Env as ProxyEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    /** The test pool's `env` from `cloudflare:test`: the bindings of wrangler.test.jsonc. */
    // oxlint-disable-next-line no-empty-object-type
    interface Env extends ProxyEnv {}
  }
}

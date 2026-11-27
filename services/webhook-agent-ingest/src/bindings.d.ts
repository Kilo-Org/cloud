import type { BundleBinding } from '@kilocode/secrets-client';

// `wrangler types` types the cross-Worker entrypoint binding as a plain `Service`; this layers on
// the `SecretsBroker` RPC shape so call sites need no runtime cast. Optional, as generated: only
// the production block binds STS, and `env.dev` keeps the Secrets Store source.
declare global {
  interface Env {
    STS?: Service & BundleBinding;
  }
}

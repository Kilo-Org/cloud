import type { BundleBinding } from '@kilocode/secrets-client';

// `wrangler types` types a cross-Worker entrypoint binding as a plain `Service`; this layers on
// the `SecretsBroker` RPC shape so the binding needs no runtime narrowing.
declare global {
  interface Env {
    STS: Service & BundleBinding;
  }
}

export {};

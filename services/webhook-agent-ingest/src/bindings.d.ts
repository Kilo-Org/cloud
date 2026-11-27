import type { BundleBinding } from '@kilocode/secrets-client';
import type {} from '../worker-configuration.d.ts';

// `wrangler types` types a cross-Worker entrypoint binding as a plain `Service`; this layers on
// the `SecretsBroker` RPC shape and the source flag so the binding needs no runtime narrowing.
declare global {
  interface Env {
    STS?: Service & BundleBinding;
    // Where every runtime secret read goes: `env` (the Secrets Store bindings above) or `sts` (the
    // bundle over `STS`). An absent value means `env`; any other value refuses every read.
    SECRETS_SOURCE?: string;
  }
}

export {};

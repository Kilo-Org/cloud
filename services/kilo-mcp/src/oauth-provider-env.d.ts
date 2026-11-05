import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

// The OAuth SDK injects this helper; Wrangler cannot derive it from a binding.
declare global {
  interface Env {
    OAUTH_PROVIDER: OAuthHelpers;
  }
  namespace Cloudflare {
    interface Env {
      OAUTH_PROVIDER: OAuthHelpers;
    }
    interface DevEnv {
      OAUTH_PROVIDER: OAuthHelpers;
    }
  }
}

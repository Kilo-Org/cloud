declare namespace Cloudflare {
  interface Env {
    /**
     * Kilo's shared NEXTAUTH_SECRET, used to verify user JWTs.
     * Bound via the Cloudflare Secrets Store.
     */
    NEXTAUTH_SECRET: SecretsStoreSecret;

    /**
     * Base URL of the kilo-deploy-builder worker, e.g. https://kilo-deploy-builder.workers.dev
     */
    BUILDER_URL: string;

    /**
     * Bearer token for authenticating with the builder worker (plain secret).
     */
    BUILDER_AUTH_TOKEN: string;

    /**
     * Base domain for deployed sites, e.g. "d.kiloapps.io".
     * URLs will be <slug>.<DEPLOY_HOSTNAME_BASE>.
     * Defaults to "d.kiloapps.io" if unset.
     */
    DEPLOY_HOSTNAME_BASE?: string;
  }
}

type Env = Cloudflare.Env;

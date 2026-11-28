// Hand-maintained: this Worker's `wrangler types` refuses to overwrite a file it did not generate
// ("A non-Wrangler worker-configuration.d.ts already exists"), so edit these entries by hand.
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import('./src/worker');
		durableNamespaces: 'GrafanaContainer';
	}
	interface Env {
		// Bound in production only: the `dev` block runs the analytics proxy off, so this reads as
		// absent there and src/secrets.ts treats it as a feature that deployment does not deploy.
		CF_ANALYTICS_API_KEY?: SecretsStoreSecret;
		GF_SECRET_KEY: SecretsStoreSecret;
		SECRETS_SOURCE?: 'secrets-store' | 'sts';
		ENVIRONMENT: 'production' | 'development';
		CF_ACCESS_TEAM: 'engineering-e11';
		CF_ACCESS_AUD: '7f6eda4c0714f6ea2afb74a3f055db65659b67571a913eab42468636a9b8c8be';
		CF_CLICKHOUSE_URL: string;
		CF_ACCOUNT_ID: string;
		GRAFANA_CONTAINER: DurableObjectNamespace<import('./src/worker').GrafanaContainer>;
	}
}
interface SecretsStoreSecret {
	get(): Promise<string>;
}
interface Env extends Cloudflare.Env {}

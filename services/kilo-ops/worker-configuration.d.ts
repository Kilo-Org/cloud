declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import('./src/worker');
		durableNamespaces: 'GrafanaContainer';
	}
	interface Env {
		CF_ANALYTICS_API_KEY: SecretsStoreSecret;
		GF_SECRET_KEY: SecretsStoreSecret;
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

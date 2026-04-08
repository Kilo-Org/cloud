declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import('./src/worker');
		durableNamespaces: 'GrafanaContainer';
	}
	interface Env {
		NEXTAUTH_SECRET: SecretsStoreSecret;
		ENVIRONMENT: 'production' | 'development';
		CF_ACCESS_TEAM: 'engineering-e11';
		CF_ACCESS_AUD: '7f6eda4c0714f6ea2afb74a3f055db65659b67571a913eab42468636a9b8c8be';
		GRAFANA_CONTAINER: DurableObjectNamespace<import('./src/worker').GrafanaContainer>;
	}
}
interface Env extends Cloudflare.Env {}
interface SecretsStoreSecret {
	get(): Promise<string>;
}
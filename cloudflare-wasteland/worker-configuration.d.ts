/* eslint-disable */
// Manually created for cloudflare-wasteland. Will be replaced by `wrangler types` output
// once wrangler.jsonc is finalized.

declare namespace Cloudflare {
	interface Env {
		WASTELAND: DurableObjectNamespace<import('./src/dos/Wasteland.do').WastelandDO>;
		WASTELAND_CONTAINER: DurableObjectNamespace;
		WASTELAND_ENCRYPTION_KEY: SecretsStoreSecret;
		NEXTAUTH_SECRET: SecretsStoreSecret;
		ENVIRONMENT: 'development' | 'production';
		KILO_API_URL: string;
		WASTELAND_API_URL: string;
	}
}

interface Env extends Cloudflare.Env {}

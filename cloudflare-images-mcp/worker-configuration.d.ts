declare namespace Cloudflare {
  interface Env {
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    R2_ENDPOINT: string;
    NEXTAUTH_SECRET: SecretsStoreSecret;
    BUCKET_PUBLIC_URLS: string;
  }
}

type Env = Cloudflare.Env;

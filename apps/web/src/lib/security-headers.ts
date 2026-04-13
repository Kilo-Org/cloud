export const CSP_NONCE_HEADER = 'x-nonce';

export type ContentSecurityPolicyOptions = {
  nonce: string;
  isDevelopment?: boolean;
  connectSrcUrls?: Array<string | undefined>;
};

function compactUnique(values: Array<string | null | undefined>): string[] {
  const compacted = values.filter((value): value is string => Boolean(value && value.length > 0));
  return Array.from(new Set(compacted));
}

function originFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function getConfiguredConnectSrcOrigins(
  env: Record<string, string | undefined> = process.env
): string[] {
  return compactUnique([
    originFromUrl(env.NEXT_PUBLIC_CLOUD_AGENT_WS_URL),
    originFromUrl(env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL),
    originFromUrl(env.NEXT_PUBLIC_SESSION_INGEST_WS_URL),
    originFromUrl(env.NEXT_PUBLIC_GASTOWN_URL),
  ]);
}

export function buildContentSecurityPolicy({
  nonce,
  isDevelopment = false,
  connectSrcUrls = getConfiguredConnectSrcOrigins(),
}: ContentSecurityPolicyOptions): string {
  const scriptSrc = compactUnique([
    "'self'",
    `'nonce-${nonce}'`,
    "'wasm-unsafe-eval'",
    isDevelopment ? "'unsafe-eval'" : null,
    'https://www.googletagmanager.com',
    'https://utt.impactcdn.com',
    'https://login.kilo.ai',
    'https://login-test.kilo.ai',
    'https://js.stripe.com',
    'https://*.js.stripe.com',
    'https://checkout.stripe.com',
    'https://challenges.cloudflare.com',
  ]);

  const connectSrc = compactUnique([
    "'self'",
    'https://auth.kilo.ai',
    'https://us.i.posthog.com',
    'https://us-assets.i.posthog.com',
    'https://api.stripe.com',
    'https://r.stripe.com',
    'https://m.stripe.com',
    'https://checkout.stripe.com',
    'https://utt.impactcdn.com',
    'https://challenges.cloudflare.com',
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    isDevelopment ? 'http://localhost:*' : null,
    isDevelopment ? 'ws://localhost:*' : null,
    ...connectSrcUrls.map(originFromUrl),
  ]);

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'self'"],
    'form-action': ["'self'"],
    'script-src': scriptSrc,
    'connect-src': connectSrc,
    'img-src': [
      "'self'",
      'data:',
      'blob:',
      'https://lh3.googleusercontent.com',
      'https://avatars.githubusercontent.com',
      'https://*.stripe.com',
      'https://www.googletagmanager.com',
      'https://utt.impactcdn.com',
      'https://challenges.cloudflare.com',
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'frame-src': [
      "'self'",
      'https://js.stripe.com',
      'https://*.js.stripe.com',
      'https://hooks.stripe.com',
      'https://checkout.stripe.com',
      'https://challenges.cloudflare.com',
    ],
    'worker-src': ["'self'", 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };

  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

export function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

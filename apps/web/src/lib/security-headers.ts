export const CSP_NONCE_HEADER = 'x-nonce';

type CspDirective =
  | 'script-src'
  | 'connect-src'
  | 'img-src'
  | 'style-src'
  | 'font-src'
  | 'frame-src'
  | 'worker-src'
  | 'media-src';

export type ContentSecurityPolicyOptions = {
  nonce: string;
  isDevelopment?: boolean;
  connectSrcUrls?: Array<string | undefined>;
  env?: Record<string, string | undefined>;
};

const ADDITIONAL_SOURCE_ENV_BY_DIRECTIVE = {
  'script-src': 'CSP_ADDITIONAL_SCRIPT_SRC',
  'connect-src': 'CSP_ADDITIONAL_CONNECT_SRC',
  'img-src': 'CSP_ADDITIONAL_IMG_SRC',
  'style-src': 'CSP_ADDITIONAL_STYLE_SRC',
  'font-src': 'CSP_ADDITIONAL_FONT_SRC',
  'frame-src': 'CSP_ADDITIONAL_FRAME_SRC',
  'worker-src': 'CSP_ADDITIONAL_WORKER_SRC',
  'media-src': 'CSP_ADDITIONAL_MEDIA_SRC',
} satisfies Record<CspDirective, string>;

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

function parseAdditionalCspSources(value: string | undefined): string[] {
  if (!value || value.includes(';')) return [];
  return compactUnique(
    value
      .split(/[\s,]+/)
      .map(source => source.trim())
      .filter(source => source.length > 0)
  );
}

function getAdditionalCspSources(
  directive: CspDirective,
  env: Record<string, string | undefined>
): string[] {
  return parseAdditionalCspSources(env[ADDITIONAL_SOURCE_ENV_BY_DIRECTIVE[directive]]);
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
  connectSrcUrls,
  env = process.env,
}: ContentSecurityPolicyOptions): string {
  const configuredConnectSrcUrls = connectSrcUrls ?? getConfiguredConnectSrcOrigins(env);
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
    ...getAdditionalCspSources('script-src', env),
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
    ...configuredConnectSrcUrls.map(originFromUrl),
    ...getAdditionalCspSources('connect-src', env),
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
      ...getAdditionalCspSources('img-src', env),
    ],
    'style-src': ["'self'", "'unsafe-inline'", ...getAdditionalCspSources('style-src', env)],
    'font-src': ["'self'", 'data:', ...getAdditionalCspSources('font-src', env)],
    'frame-src': [
      "'self'",
      'https://js.stripe.com',
      'https://*.js.stripe.com',
      'https://hooks.stripe.com',
      'https://checkout.stripe.com',
      'https://challenges.cloudflare.com',
      ...getAdditionalCspSources('frame-src', env),
    ],
    'worker-src': ["'self'", 'blob:', ...getAdditionalCspSources('worker-src', env)],
    'media-src': ["'self'", 'blob:', ...getAdditionalCspSources('media-src', env)],
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

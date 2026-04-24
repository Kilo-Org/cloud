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
  isDevelopment?: boolean;
  connectSrcUrls?: Array<string | undefined>;
  env?: Record<string, string | undefined>;
};

export type ContentSecurityPolicyMode = 'enforce' | 'report-only' | 'off';

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

function webSocketOriginFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return `wss://${url.host}`;
    if (url.protocol === 'http:') return `ws://${url.host}`;
    if (url.protocol === 'wss:' || url.protocol === 'ws:') return url.origin;
    return null;
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
    webSocketOriginFromUrl(env.NEXT_PUBLIC_GASTOWN_URL),
    originFromUrl(env.NEXT_PUBLIC_SENTRY_DSN),
  ]);
}

export function getContentSecurityPolicyMode(
  env: Record<string, string | undefined> = process.env
): ContentSecurityPolicyMode {
  const configuredMode = env.CSP_MODE?.trim().toLowerCase();
  if (configuredMode === 'off' || configuredMode === 'report-only') return configuredMode;
  return 'enforce';
}

export function getContentSecurityPolicyHeaderName(mode: ContentSecurityPolicyMode): string | null {
  if (mode === 'off') return null;
  if (mode === 'report-only') return 'Content-Security-Policy-Report-Only';
  return 'Content-Security-Policy';
}

export function buildContentSecurityPolicy({
  isDevelopment = false,
  connectSrcUrls,
  env = process.env,
}: ContentSecurityPolicyOptions = {}): string {
  const configuredConnectSrcUrls = connectSrcUrls ?? getConfiguredConnectSrcOrigins(env);
  const scriptSrc = compactUnique([
    "'self'",
    "'unsafe-inline'",
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
    'https://widget.usepylon.com',
    'https://assets.churnkey.co',
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
    'https://widget.usepylon.com',
    'https://assets.churnkey.co',
    'https://api.churnkey.co',
    'https://*.churnkey.co',
    'https://*.d.kiloapps.io',
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
      'https://widget.usepylon.com',
      'https://assets.churnkey.co',
      'https://*.churnkey.co',
      'https://www.gravatar.com',
      'https://openrouter.ai',
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
      'https://www.youtube.com',
      'https://widget.usepylon.com',
      'https://assets.churnkey.co',
      'https://*.churnkey.co',
      'https://*.d.kiloapps.io',
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

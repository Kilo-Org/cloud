export type ContentSecurityPolicyOptions = {
  isDevelopment?: boolean;
  connectSrcUrls?: Array<string | undefined>;
  env?: Record<string, string | undefined>;
};

export type ContentSecurityPolicyMode = 'enforce' | 'report-only' | 'off';

const CSP_REPORTING_GROUP = 'csp-endpoint';
const SENTRY_SECURITY_REPORT_MAX_AGE_SECONDS = 10886400;

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

function getSentryEnvironment(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 64 || /[\s/]/.test(trimmed) || trimmed === 'None') return null;
  return trimmed;
}

function getOptionalQueryValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function getSentrySecurityReportUri(
  env: Record<string, string | undefined> = process.env
): string | null {
  const dsn = env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return null;

  try {
    const url = new URL(dsn);
    const projectId = url.pathname.split('/').filter(Boolean).at(-1);
    const sentryKey = url.username;
    if (!projectId || !sentryKey) return null;

    const reportUri = new URL(`/api/${projectId}/security/`, url.origin);
    reportUri.searchParams.set('sentry_key', sentryKey);

    const sentryEnvironment = getSentryEnvironment(env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV);
    if (sentryEnvironment) reportUri.searchParams.set('sentry_environment', sentryEnvironment);

    const sentryRelease = getOptionalQueryValue(env.SENTRY_RELEASE);
    if (sentryRelease) reportUri.searchParams.set('sentry_release', sentryRelease);

    return reportUri.toString();
  } catch {
    return null;
  }
}

export function getSecurityPolicyReportingHeaders(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const reportUri = getSentrySecurityReportUri(env);
  if (!reportUri) return {};

  return {
    'Report-To': JSON.stringify({
      group: CSP_REPORTING_GROUP,
      max_age: SENTRY_SECURITY_REPORT_MAX_AGE_SECONDS,
      endpoints: [{ url: reportUri }],
      include_subdomains: true,
    }),
    'Reporting-Endpoints': `${CSP_REPORTING_GROUP}="${reportUri}"`,
  };
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
  if (
    configuredMode === 'enforce' ||
    configuredMode === 'off' ||
    configuredMode === 'report-only'
  ) {
    return configuredMode;
  }
  return 'report-only';
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
  ]);

  const reportUri = getSentrySecurityReportUri(env);

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
      'https://secure.gravatar.com',
      'https://gravatar.com',
      'https://media.licdn.com',
      'https://cdn.discordapp.com',
      'https://gitlab.com',
      'https://*.stripe.com',
      'https://www.googletagmanager.com',
      'https://utt.impactcdn.com',
      'https://widget.usepylon.com',
      'https://assets.churnkey.co',
      'https://*.churnkey.co',
      'https://www.gravatar.com',
      'https://openrouter.ai',
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
      'https://www.youtube.com',
      'https://widget.usepylon.com',
      'https://assets.churnkey.co',
      'https://*.churnkey.co',
      'https://*.d.kiloapps.io',
    ],
    'worker-src': ["'self'", 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    ...(reportUri ? { 'report-uri': [reportUri], 'report-to': [CSP_REPORTING_GROUP] } : {}),
  };

  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

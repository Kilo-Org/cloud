import { STANDARD_OAUTH_PLATFORMS } from '@/lib/integrations/oauth/paths';

const CALLBACK_PATH_REGEX = /^\/(users\/)?[-a-zA-Z0-9]+\/?(\?.*)?(#.*)?$/;
const PLACEHOLDER_ORIGIN = 'https://placeholder.invalid';
const STANDARD_OAUTH_PLATFORM_SET: ReadonlySet<string> = new Set(STANDARD_OAUTH_PLATFORMS);

export function stripHost(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname + urlObj.search + urlObj.hash;
  } catch {
    // If it's not a valid URL, assume it's already a path
    return url;
  }
}

export function isValidCallbackPath(path: string): boolean {
  if (
    path.startsWith('/users/accept-invite') ||
    path.startsWith('/get-started') ||
    path.startsWith('/welcome/landing') ||
    path.startsWith('/organizations/') ||
    path === '/claw' ||
    path.startsWith('/claw/') ||
    path.startsWith('/cloud') ||
    path === '/subscriptions/kilo-pass' ||
    path.startsWith('/subscriptions/kilo-pass/') ||
    path.startsWith('/integrations/') ||
    // Admin-managed URL bonus campaigns. Stricter shape enforcement
    // (slug format, prefix-match guard) happens in
    // `isCreditCampaignCallback`; this check only decides whether the
    // sign-in redirect is allowed to preserve the path.
    path.startsWith('/c/')
  ) {
    return true;
  }
  if (isValidIntegrationOAuthConnectCallbackPath(path)) {
    return true;
  }
  return CALLBACK_PATH_REGEX.test(path);
}

function isValidIntegrationOAuthConnectCallbackPath(path: string): boolean {
  if (!path.startsWith('/api/integrations/') || path.startsWith('//')) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(path, PLACEHOLDER_ORIGIN);
  } catch {
    return false;
  }

  if (url.origin !== PLACEHOLDER_ORIGIN || url.hash) {
    return false;
  }

  if (url.searchParams.has('clientSecret')) {
    return false;
  }

  const [, api, integrations, platform, action, ...rest] = url.pathname.split('/');
  return (
    api === 'api' &&
    integrations === 'integrations' &&
    action === 'connect' &&
    rest.length === 0 &&
    STANDARD_OAUTH_PLATFORM_SET.has(platform)
  );
}

export default function getSignInCallbackUrl(searchParams?: NextAppSearchParams): string {
  const callbackParams = new URLSearchParams();

  if (typeof searchParams?.source === 'string' && searchParams?.source) {
    callbackParams.set('source', searchParams?.source);
  }

  // Order matters: tests assert this exact emission order through the
  // sign-in callback redirect (see getSignInCallbackUrl.test.ts).
  const trackingParams = [
    'im_ref',
    '_saasquatch',
    'rsCode',
    'rsShareMedium',
    'rsEngagementMedium',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
  ] as const;
  for (const trackingParam of trackingParams) {
    const value = searchParams?.[trackingParam];
    if (typeof value === 'string' && value) {
      callbackParams.set(trackingParam, value);
    }
  }

  // Always route through /users/after-sign-in to ensure stytch verification check
  if (
    typeof searchParams?.callbackPath === 'string' &&
    isValidCallbackPath(searchParams.callbackPath)
  ) {
    callbackParams.set('callbackPath', searchParams.callbackPath);
  }

  // Preserve signup=true so an OAuth error bounce (see parseSignInRedirectContext
  // in user.server.ts) can send the user back to the create-account UI instead
  // of the plain sign-in UI.
  if (searchParams?.signup === 'true') {
    callbackParams.set('signup', 'true');
  }

  return `/users/after-sign-in${callbackParams.size > 0 ? `?${callbackParams.toString()}` : ''}`;
}

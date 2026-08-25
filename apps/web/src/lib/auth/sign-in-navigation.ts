import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';

const PRESERVED_SIGN_IN_QUERY_PARAMS = [
  'source',
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

function buildSignInHref(searchParams: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();

  for (const key of PRESERVED_SIGN_IN_QUERY_PARAMS) {
    const value = searchParams[key];
    if (value) {
      params.set(key, value);
    }
  }

  const callbackPath = searchParams.callbackPath;
  if (callbackPath && isValidCallbackPath(callbackPath)) {
    params.set('callbackPath', callbackPath);
  }

  return params;
}

/**
 * Builds a fresh normal sign-in URL from only approved navigation context.
 * In particular, this drops prior SSO/domain routing, auth errors, invitation
 * fields, and signup mode rather than carrying them into the destination.
 */
export function buildNormalSignInHref(searchParams: Record<string, string>): string {
  const query = buildSignInHref(searchParams).toString();
  return query ? `/users/sign_in?${query}` : '/users/sign_in';
}

/**
 * Builds an Enterprise SSO URL from context that is safe to carry into a new
 * sign-in route. Auth errors, invite data, and previous routing mode are
 * deliberately excluded because this link starts a fresh Enterprise SSO flow.
 */
export function buildEnterpriseSsoHref(searchParams: Record<string, string>): string {
  const params = buildSignInHref(searchParams);
  params.set('sso', 'true');
  return `/users/sign_in?${params.toString()}`;
}

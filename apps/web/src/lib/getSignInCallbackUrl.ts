const CALLBACK_PATH_REGEX = /^\/(users\/)?[-a-zA-Z0-9]+\/?(\?.*)?(#.*)?$/;

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
    path.startsWith('/cloud') ||
    path.startsWith('/integrations/')
  ) {
    return true;
  }
  return CALLBACK_PATH_REGEX.test(path);
}

export default function getSignInCallbackUrl(searchParams?: NextAppSearchParams): string {
  const callbackParams = new URLSearchParams();

  if (typeof searchParams?.source === 'string' && searchParams?.source) {
    callbackParams.set('source', searchParams?.source);
  }

  if (typeof searchParams?.im_ref === 'string' && searchParams?.im_ref) {
    callbackParams.set('im_ref', searchParams.im_ref);
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

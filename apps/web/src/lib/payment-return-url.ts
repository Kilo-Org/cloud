import 'server-only';
import { cookies } from 'next/headers';

const RETURN_URL_COOKIE_NAME = 'payment-return-url';
const RETURN_URL_COOKIE_MAX_AGE = 60 * 30; // 30 minutes

/**
 * Validates that a return URL resolves to the application origin and returns
 * its pathname, search, and hash form, or null when the value is not a
 * same-origin path.
 */
export function getSafeReturnUrlPath(url: string): string | null {
  if (!url.startsWith('/') || /[\u0000-\u001F\u007F\\]/.test(url)) {
    return null;
  }

  try {
    const base = new URL('http://localhost');
    const parsed = new URL(url, base);

    if (parsed.origin !== base.origin || parsed.username || parsed.password) {
      return null;
    }

    if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) {
      return null;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/**
 * Sets a secure HTTP-only cookie with the return URL for post-payment redirect.
 * The URL is validated to ensure it's a safe internal path.
 */
export async function setPaymentReturnUrl(returnUrl: string): Promise<boolean> {
  const safeReturnUrl = getSafeReturnUrlPath(returnUrl);
  if (safeReturnUrl === null) {
    console.warn('[PAYMENT-RETURN-URL] Invalid return URL rejected:', returnUrl);
    return false;
  }

  const cookieStore = await cookies();
  const isDev = process.env.NODE_ENV === 'development';

  cookieStore.set(RETURN_URL_COOKIE_NAME, safeReturnUrl, {
    httpOnly: true,
    secure: !isDev,
    sameSite: isDev ? 'lax' : 'none',
    maxAge: RETURN_URL_COOKIE_MAX_AGE,
    path: '/',
  });

  return true;
}

/**
 * Retrieves and clears the payment return URL cookie.
 * Returns null if no valid return URL is found.
 */
export async function getAndClearPaymentReturnUrl(): Promise<string | null> {
  const cookieStore = await cookies();
  const returnUrlCookie = cookieStore.get(RETURN_URL_COOKIE_NAME);

  if (!returnUrlCookie?.value) {
    return null;
  }

  // Clear the cookie immediately
  cookieStore.delete(RETURN_URL_COOKIE_NAME);

  // Validate and normalize the URL before returning it
  const safeReturnUrl = getSafeReturnUrlPath(returnUrlCookie.value);
  if (safeReturnUrl === null) {
    console.warn('[PAYMENT-RETURN-URL] Invalid return URL in cookie:', returnUrlCookie.value);
    return null;
  }

  return safeReturnUrl;
}

/**
 * Clears the payment return URL cookie without retrieving it.
 */
export async function clearPaymentReturnUrl(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(RETURN_URL_COOKIE_NAME);
}

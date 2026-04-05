import 'server-only';
import { cookies } from 'next/headers';

const RETURN_URL_COOKIE_NAME = 'payment-return-url';
const RETURN_URL_COOKIE_MAX_AGE = 60 * 30; // 30 minutes

/**
 * Validates that a return URL is safe to redirect to.
 * Only allows internal URLs (same origin) to prevent open redirect vulnerabilities.
 */
export function isValidReturnUrl(url: string): boolean {
  try {
    // Parse the URL
    new URL(url, 'http://localhost'); // Use a base URL for relative paths

    // Only allow relative paths (no protocol or host)
    // This ensures we only redirect within our own application
    if (url.startsWith('/') && !url.startsWith('//')) {
      // Additional checks for relative URLs
      // Prevent protocol-relative URLs like //evil.com
      // Prevent javascript: or data: URLs
      if (url.match(/^\/[^/]/)) {
        return true;
      }
    }

    return false;
  } catch {
    // If URL parsing fails, it's not valid
    return false;
  }
}

/**
 * Sets a secure HTTP-only cookie with the return URL for post-payment redirect.
 * The URL is validated to ensure it's a safe internal path.
 */
export async function setPaymentReturnUrl(returnUrl: string): Promise<boolean> {
  if (!isValidReturnUrl(returnUrl)) {
    console.warn('[PAYMENT-RETURN-URL] Invalid return URL rejected:', returnUrl);
    return false;
  }

  const cookieStore = await cookies();
  const isDev = process.env.NODE_ENV === 'development';

  cookieStore.set(RETURN_URL_COOKIE_NAME, returnUrl, {
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

  // Validate the URL before returning it
  if (!isValidReturnUrl(returnUrlCookie.value)) {
    console.warn('[PAYMENT-RETURN-URL] Invalid return URL in cookie:', returnUrlCookie.value);
    return null;
  }

  return returnUrlCookie.value;
}

/**
 * Clears the payment return URL cookie without retrieving it.
 */
export async function clearPaymentReturnUrl(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(RETURN_URL_COOKIE_NAME);
}

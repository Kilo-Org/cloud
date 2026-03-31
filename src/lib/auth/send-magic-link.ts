import { captureException } from '@sentry/nextjs';

export type SendMagicLinkResult = { success: true } | { success: false; error: string };

/**
 * Sends a magic link email to the specified address.
 * Uses the Turnstile JWT cookie (from previous verification) for authentication.
 *
 * @param email - The email address to send the magic link to
 * @param callbackUrl - Optional post-sign-in redirect URL (e.g. from getSignInCallbackUrl)
 * @returns Promise resolving to success/error result
 */
export async function sendMagicLink(
  email: string,
  callbackUrl?: string
): Promise<SendMagicLinkResult> {
  try {
    const response = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, callbackUrl }),
    });

    const result = await response.json();
    if (response.ok && result.success) {
      return { success: true };
    }

    console.error('Magic link request failed:', result.error);
    return {
      success: false,
      error: result.error || 'Failed to send magic link',
    };
  } catch (error) {
    console.error('Magic link request error:', error);
    captureException(error, { tags: { source: 'magic_link_request' } });
    return {
      success: false,
      error: 'Failed to send magic link. Please try again.',
    };
  }
}

/**
 * Mock implementation of InsufficientBalanceBanner.actions for Storybook
 * The real implementation uses 'server-only' which cannot be imported in client-side contexts
 */

export async function setReturnUrlAndRedirect(
  _returnUrl: string,
  creditsUrl: string
): Promise<string> {
  // In Storybook, just return the credits URL without setting any cookies
  console.log('[Storybook Mock] setReturnUrlAndRedirect called');
  return creditsUrl;
}

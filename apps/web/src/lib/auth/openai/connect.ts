import { signIn } from 'next-auth/react';
import { OPENAI_TOKEN_SHARING_SCOPE } from './scopes';

/**
 * The connect round-trip for a delegated "Sign in with ChatGPT" connection,
 * shared by every entry point that can start it: the BYOK card, the promo bar,
 * and the organization BYOK page.
 */

/** Where the connect call returns after OpenAI redirects back to the app. */
const BYOK_PATH = '/byok';

export function openAiChatGptByokPath(organizationId: string | undefined): string {
  return organizationId ? `/organizations/${organizationId}/byok` : BYOK_PATH;
}

/**
 * Starts the connect round-trip: first an account-linking session for the
 * signed-in person, then the OpenAI authorization with the token-sharing
 * scope. The linking session is what lets the callback attach this identity to
 * the current account (and skip the sign-in Turnstile gate); it must succeed
 * before the browser leaves for OpenAI. When `organizationId` is set, the
 * linking session records the organization and the callback returns to its BYOK
 * page.
 */
export async function startOpenAiChatGptConnect(
  createLinkingSession: () => Promise<unknown>,
  organizationId?: string
): Promise<void> {
  await createLinkingSession();
  await signIn(
    'openai',
    { callbackUrl: openAiChatGptByokPath(organizationId) },
    { scope: OPENAI_TOKEN_SHARING_SCOPE }
  );
}

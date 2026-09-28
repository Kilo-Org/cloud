/**
 * PostHog flag gating the "Sign in with ChatGPT" sign-in option and the OpenAI
 * (ChatGPT subscription) BYOK card.
 *
 * The flag's release condition holds the approved email domains. A signed-out
 * visitor has no PostHog person, so `useChatGptSignInAccess` evaluates the flag
 * against the email the visitor typed; it does not carry its own allow-list.
 */
export const CHATGPT_ACCESS_FLAG = 'sign-in-with-chatgpt';

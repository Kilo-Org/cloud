/**
 * PostHog flag gating the OpenAI (ChatGPT subscription) BYOK connection: the
 * BYOK card, and the sidebar and page entries that lead to it.
 *
 * The flag's release condition holds the approved email domains, so it needs a
 * person. The sign-in option itself is not gated: 'Continue with ChatGPT' is
 * offered with the other OAuth providers to every visitor.
 */
export const CHATGPT_ACCESS_FLAG = 'sign-in-with-chatgpt';

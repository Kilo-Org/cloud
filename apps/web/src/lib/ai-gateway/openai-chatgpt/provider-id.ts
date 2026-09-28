/**
 * The dedicated BYOK provider id for a delegated "Sign in with ChatGPT"
 * connection. It is deliberately NOT added to `UserByokProviderIdSchema`: the
 * connection store reads the row directly, so leaving the enum alone keeps the
 * id out of every key-entry provider list. The user-pasted Vercel `openai` key
 * entry is a separate provider and keeps working untouched.
 */
export const OPENAI_CHATGPT_PROVIDER_ID = 'openai-chatgpt';

export const OPENAI_CHATGPT_PROVIDER_NAME = 'OpenAI (Sign in with ChatGPT)';

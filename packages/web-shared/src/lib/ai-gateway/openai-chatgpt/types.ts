import { z } from 'zod';

/**
 * The delegated OpenAI OAuth token pair. `expires_at` is epoch seconds, the
 * same unit `Account.expires_at` uses in the sign-in callback.
 * `earliest_refresh_at`, when OpenAI returns it, is epoch seconds before which
 * the token must not be refreshed again.
 */
export const OpenAiChatGptTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_at: z.number(),
  earliest_refresh_at: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

/**
 * The stored connection: the token pair plus the issuer-qualified identity the
 * tokens belong to and the state the UI reads (connected vs. needs reconnect).
 */
export const OpenAiChatGptConnectionSchema = OpenAiChatGptTokensSchema.extend({
  issuer: z.string(),
  client_id: z.string(),
  subject: z.string(),
  email: z.string().optional(),
  connected_at: z.string(),
  status: z.enum(['connected', 'error']),
  error_message: z.string().optional(),
  error_at: z.string().optional(),
});

export type OpenAiChatGptTokens = z.infer<typeof OpenAiChatGptTokensSchema>;
export type OpenAiChatGptConnection = z.infer<typeof OpenAiChatGptConnectionSchema>;

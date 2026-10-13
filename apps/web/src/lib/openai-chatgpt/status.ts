import { z } from 'zod';

/**
 * The user-visible status of a "Sign in with ChatGPT" connection, shared by the
 * `openAiChatGpt.status` procedure and the BYOK card that renders it.
 *
 * It carries no credential: the access token, the refresh token and any raw
 * OAuth error body stay server-side. `subject` is the OpenAI `sub` claim, shown
 * only as the fallback label when the delegated token has no email claim.
 */
export const OpenAiChatGptStatusSchema = z.object({
  state: z.enum(['disconnected', 'connected', 'error']),
  email: z.string().optional(),
  subject: z.string().optional(),
  connectedAt: z.string().optional(),
  /**
   * The current ChatGPT plan usage limit. Absent means no limit is known or the
   * recorded one has expired, so a client renders the usage-limit message only
   * when this is present.
   */
  usageLimit: z
    .object({
      /** ISO timestamp of the request that OpenAI answered with the limit. */
      reachedAt: z.string(),
      /** ISO timestamp of the reported reset, or null when OpenAI gave none. */
      resetsAt: z.string().nullable(),
    })
    .optional(),
  errorMessage: z.string().optional(),
});

export type OpenAiChatGptStatus = z.infer<typeof OpenAiChatGptStatusSchema>;

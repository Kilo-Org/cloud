import { z } from 'zod';

export const kiloChatTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
});

export type KiloChatTokenResponse = z.infer<typeof kiloChatTokenResponseSchema>;

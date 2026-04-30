import { z } from 'zod';

export const kiloChatTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  userId: z.string().min(1),
});

export type KiloChatTokenResponse = z.infer<typeof kiloChatTokenResponseSchema>;

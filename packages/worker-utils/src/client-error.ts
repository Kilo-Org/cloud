import { z } from 'zod';

export const PublicErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const ClientErrorSchema = z.object({
  code: PublicErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});

export type ClientError = z.infer<typeof ClientErrorSchema>;

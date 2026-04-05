import { z } from 'zod';

// ============================================
// Credentials Endpoint Schemas
// GET /admin/apps/{appId}/credentials
// ============================================

export const CredentialsResponseSchema = z.object({
  appId: z.string(),
  dbUrl: z.string(),
  dbToken: z.string().nullable(),
  provisioned: z.boolean(),
});

export type CredentialsResponse = z.infer<typeof CredentialsResponseSchema>;

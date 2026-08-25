import * as z from 'zod';
import { emailSchema } from '@/lib/schemas/email';

export const SignInDiscoveryRequestSchema = emailSchema;

export const SignInDiscoveryResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sso'), organizationId: z.string().min(1) }),
  z.object({ kind: z.literal('existing'), providers: z.array(z.string()) }),
  z.object({ kind: z.literal('new'), providers: z.array(z.string()) }),
]);

export type SignInDiscoveryResponse = z.infer<typeof SignInDiscoveryResponseSchema>;

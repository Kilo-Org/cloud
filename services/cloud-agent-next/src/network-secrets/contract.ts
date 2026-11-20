import { networkSecretPolicySchema } from '@kilocode/worker-utils/network-secrets';
import { z } from 'zod';

export const resolvedNetworkSecretSchema = networkSecretPolicySchema.extend({
  type: z.literal('network'),
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z
    .string()
    .min(1)
    .max(8192)
    .refine(value => !/[\r\n\0]/.test(value)),
});
export type ResolvedNetworkSecret = z.infer<typeof resolvedNetworkSecretSchema>;

export const networkSecretResolutionSchema = z.discriminatedUnion('type', [
  resolvedNetworkSecretSchema,
  z.object({
    type: z.literal('network-denied'),
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    reason: z.enum(['host_mismatch', 'location_denied', 'policy_denied']),
  }),
]);
export type NetworkSecretResolution = z.infer<typeof networkSecretResolutionSchema>;

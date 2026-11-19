import { z } from 'zod';
import { nativeEgressAllowlistSchema } from '../sandbox-control/egress-policy.js';

export const nativeEgressPolicySchema = z
  .object({
    allocationRef: z.string().min(1),
    allowlist: nativeEgressAllowlistSchema.optional(),
    egressAudit: z.boolean().optional(),
  })
  .refine(policy => policy.allowlist !== undefined || policy.egressAudit === true, {
    message: 'Container egress policy requires an allowlist or auditing',
  });

export type NativeEgressPolicy = z.infer<typeof nativeEgressPolicySchema>;

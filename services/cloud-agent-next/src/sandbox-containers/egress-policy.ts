import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';
import { z } from 'zod';

export const nativeEgressAllowlistSchema = z
  .array(egressDomainSchema)
  .transform(domains => [...new Set(domains)].sort());

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

export function isAllowedEgressUrl(url: URL, allowlist: readonly string[]): boolean {
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return false;
  }
  const hostname = egressDomainSchema.safeParse(url.hostname);
  return hostname.success && allowlist.includes(hostname.data);
}

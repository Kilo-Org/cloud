import { z } from 'zod';

export const egressDomainSchema = z
  .string()
  .max(254)
  .regex(/^[A-Za-z0-9.-]+$/)
  .transform(value => value.toLowerCase().replace(/\.$/, ''))
  .refine(value => {
    if (value.length > 253) return false;
    const labels = value.split('.');
    if (
      labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      return false;
    }
    try {
      const hostname = new URL(`https://${value}`).hostname;
      return hostname === value && !/^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    } catch {
      return false;
    }
  }, 'Expected an exact ASCII DNS hostname, not a URL, wildcard, or IP address');

export const egressAllowlistSchema = z
  .array(egressDomainSchema)
  .max(100)
  .transform(domains => [...new Set(domains)].sort());

export const egressModeSchema = z.enum(['unrestricted', 'allowlist']);

export type EgressMode = z.infer<typeof egressModeSchema>;

export const egressPolicySchema = z
  .object({
    egressMode: egressModeSchema
      .optional()
      .describe(
        'Defaults to unrestricted when omitted. The allowlist mode permits the Kilo/Git baseline plus optional egressAllowlist domains.'
      ),
    egressAllowlist: egressAllowlistSchema
      .optional()
      .describe('Additional exact DNS hostnames; requires explicit allowlist mode.'),
  })
  .refine(data => data.egressAllowlist === undefined || data.egressMode === 'allowlist', {
    message: 'egressAllowlist requires egressMode to be allowlist',
    path: ['egressAllowlist'],
  });

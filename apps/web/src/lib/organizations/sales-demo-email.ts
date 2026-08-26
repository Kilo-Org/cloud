import { hosted_domain_specials } from '@/lib/auth/constants';

// Kept in sync with `platformAdminDomains` in `@/lib/admin/platform-admin.ts`.
// That file is server-only, so this small module exists to expose the same
// domain list and matching rule to non-server modules without importing it.
export const SALES_DEMO_EMAIL_DOMAINS = [
  hosted_domain_specials.kilocode_admin,
  'anaconda.com',
] as const;

export function isAllowedSalesDemoEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return SALES_DEMO_EMAIL_DOMAINS.some(domain => lower.endsWith(`@${domain}`));
}

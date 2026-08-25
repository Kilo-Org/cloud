// Kept in sync with `platformAdminDomains` in `@/lib/admin/platform-admin.ts`.
// That file is server-only, so this small module exists to expose the same
// domain list and matching rule to non-server modules without importing it.
export const SALES_DEMO_EMAIL_DOMAINS = ['kilocode.ai', 'anaconda.com'] as const;

export function isAllowedSalesDemoEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return SALES_DEMO_EMAIL_DOMAINS.some(domain => lower.endsWith(`@${domain}`));
}

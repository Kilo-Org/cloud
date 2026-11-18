// Shared default-selection ordering. Kept free of server-only imports so both
// server helpers (user/server.ts, organizations.ts) and client chrome
// (AppSidebar) can sort the same way. A sales demo org always wins; ties fall
// back to the previous created_at ASC, then id ASC order.

export type DefaultOrganizationSortable = {
  isSalesDemo?: boolean;
  created_at: string;
  organizationId: string;
};

export function compareOrganizationsForDefault(
  a: DefaultOrganizationSortable,
  b: DefaultOrganizationSortable
): number {
  const aIsDemo = a.isSalesDemo === true;
  const bIsDemo = b.isSalesDemo === true;
  if (aIsDemo !== bIsDemo) {
    return aIsDemo ? -1 : 1;
  }

  const byCreatedAt = a.created_at.localeCompare(b.created_at);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }

  return a.organizationId.localeCompare(b.organizationId);
}

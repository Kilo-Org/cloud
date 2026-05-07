type PendingNotificationNavigation = {
  href: string;
  method: 'replace';
};

export function resolvePendingNotificationNavigation(
  pendingLink: string | null
): PendingNotificationNavigation | null {
  if (!pendingLink) {
    return null;
  }
  return { href: pendingLink, method: 'replace' };
}

type PendingNavigation = {
  href: string;
  method: 'navigate';
};

// `navigate` rather than `replace`: replacing the stack root leaves the target
// screen with no back stack (no back button, user stranded), while `navigate`
// pushes an entry yet still dedupes if the route is already current.
export function resolvePendingNavigation(pendingLink: string | null): PendingNavigation | null {
  if (!pendingLink) {
    return null;
  }
  return { href: pendingLink, method: 'navigate' };
}

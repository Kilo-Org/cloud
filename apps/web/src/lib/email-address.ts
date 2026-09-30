export function getLowerDomainFromEmail(email: string): string | null {
  return email?.split('@').pop()?.toLowerCase() || null;
}

/**
 * Normalizes an email address for duplicate detection.
 * - Lowercases the entire address
 * - Strips `+` aliases (e.g. `user+tag@example.com` → `user@example.com`)
 * - For Gmail/Googlemail: removes dots from the local part
 * - Normalizes `googlemail.com` → `gmail.com` (same mailbox)
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex === -1) return trimmed;

  let local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  // Strip +alias suffix
  const plusIndex = local.indexOf('+');
  if (plusIndex !== -1) {
    local = local.slice(0, plusIndex);
  }

  // Gmail and Googlemail are the same mailbox; normalize dots and domain
  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  if (isGmail) {
    local = local.replace(/\./g, '');
  }

  return `${local}@${isGmail ? 'gmail.com' : domain}`;
}

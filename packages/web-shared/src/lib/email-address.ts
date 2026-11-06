export function getLowerDomainFromEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  return email.slice(at + 1).toLowerCase() || null;
}

/**
 * The mailbox an outbound message is delivered to, trimmed and lowercased.
 *
 * Unlike `normalizeEmail`, it keeps a `+` suffix and Gmail dots, so it is safe
 * as the identity of a delivered credential: two addresses that differ in more
 * than case are two identities here. Use `normalizeEmail` for duplicate
 * detection and signup eligibility, never for deciding who a credential
 * authenticates.
 */
export function getDeliveredEmailAddress(email: string): string {
  return email.trim().toLowerCase();
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

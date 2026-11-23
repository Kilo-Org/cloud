/**
 * Splits an address at its last `@` into the local part and the domain. An
 * address without `@` yields no domain.
 */
function splitAtLastAt(email: string): { local: string; domain: string } | null {
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

/**
 * The domain of an address, lowercased. Unlike `getDeliveredEmailAddress`, it
 * does not trim the input: the address is passed through as stored, so an
 * address carrying surrounding whitespace yields a domain with that
 * whitespace.
 */
export function getLowerDomainFromEmail(email: string): string | null {
  const split = splitAtLastAt(email);
  return split?.domain.toLowerCase() || null;
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
 */
export function normalizeEmail(email: string): string {
  const split = splitAtLastAt(email.trim().toLowerCase());
  if (!split) return email.trim().toLowerCase();

  let local = split.local;
  const domain = split.domain;

  const plusIndex = local.indexOf('+');
  if (plusIndex !== -1) {
    local = local.slice(0, plusIndex);
  }

  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  if (isGmail) {
    local = local.replace(/\./g, '');
  }

  return `${local}@${isGmail ? 'gmail.com' : domain}`;
}

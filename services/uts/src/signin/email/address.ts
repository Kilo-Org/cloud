/**
 * The one address form UTS sends email to and keys an email sign-in by: a plain RFC 5322 addr-spec
 * in lower case, `local@domain`, with no display name, comment, quoting, list separator or space.
 * Mailgun reads its `to` field as an address list, so a looser string (`x <a@example.com>`,
 * `a,b@example.com`, `"a b"@example.com`) could reach a mailbox other than the address UTS stored
 * and hashed, and many spellings of one mailbox would each get their own per-address limits.
 *
 * * Local part: 1-64 of the RFC 5322 atom characters and dots.
 * * Domain: lower-case labels of 1-63 letters, digits and hyphens that neither start nor end with
 *   a hyphen, at most 253 characters, and a last label of 2-63 letters or a punycode label
 *   (`xn--…`), the rule of the SSO domains.
 */
const LOCAL_PART = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{0,58}[a-z0-9])$/;

export function isMailDomain(value: string): boolean {
  return DOMAIN.test(value);
}

export function isMailLocalPart(value: string): boolean {
  return LOCAL_PART.test(value);
}

/** True for a lower-case addr-spec of the form above. */
export function isMailAddress(value: string): boolean {
  const at = value.lastIndexOf('@');
  return at > 0 && isMailLocalPart(value.slice(0, at)) && isMailDomain(value.slice(at + 1));
}

/** A form's address, trimmed and lower-cased, or null when it is not a plain addr-spec. */
export function mailAddress(value: string | null): string | null {
  if (value === null) return null;
  const address = value.trim().toLowerCase();
  return isMailAddress(address) ? address : null;
}

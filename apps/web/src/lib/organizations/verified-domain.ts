import 'server-only';
import { normalizeEmail } from '@/lib/utils';
import type { User } from '@kilocode/db/schema';
import { getDomain } from 'tldts';

const PUBLIC_CONSUMER_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
]);

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function canonicalizeEligibleVerifiedDomain(input: string): string | null {
  const candidate = input.trim().toLowerCase();
  if (!candidate || /[\p{Cc}\s@/\\:?#%]/u.test(candidate) || candidate.endsWith('.')) {
    return null;
  }

  let domain: string;
  try {
    domain = new URL(`http://${candidate}`).hostname;
  } catch {
    return null;
  }

  const labels = domain.split('.');
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some(label => label.length > 63 || !DNS_LABEL_PATTERN.test(label)) ||
    /^\d+$/.test(labels.at(-1) ?? '') ||
    getDomain(domain, { allowPrivateDomains: true }) === null ||
    PUBLIC_CONSUMER_EMAIL_DOMAINS.has(domain)
  ) {
    return null;
  }

  return domain;
}

function primaryEmailDomain(email: string): string | null {
  if (email !== email.trim() || /[\p{Cc}\s]/u.test(email)) return null;
  const firstAt = email.indexOf('@');
  if (firstAt <= 0 || firstAt !== email.lastIndexOf('@') || firstAt === email.length - 1) {
    return null;
  }
  return canonicalizeEligibleVerifiedDomain(email.slice(firstAt + 1));
}

export function verifiedDomainEmailIdentity(
  user: Pick<User, 'google_user_email' | 'normalized_email'>
): { domain: string; normalizedEmail: string } | null {
  const normalizedEmail = normalizeEmail(user.google_user_email);
  if (user.normalized_email !== null && user.normalized_email !== normalizedEmail) return null;
  const domain = primaryEmailDomain(user.google_user_email);
  return domain ? { domain, normalizedEmail } : null;
}

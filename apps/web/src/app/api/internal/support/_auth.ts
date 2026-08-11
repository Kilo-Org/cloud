import { createHmac, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import * as serverConfig from '@/lib/config.server';

const SECRET_COMPARE_HMAC_KEY = Buffer.from('support-api-secret-compare');

const KILO_OWNED_DOMAINS = ['kilocode.ai', 'kilo.ai'] as const;

export const RequestIdSchema = z.string().trim().min(1).max(128);

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHmac('sha256', SECRET_COMPARE_HMAC_KEY).update(provided).digest();
  const b = createHmac('sha256', SECRET_COMPARE_HMAC_KEY).update(expected).digest();
  return timingSafeEqual(a, b);
}

export function emailDomainAfterLastAt(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) return '';
  return email.slice(at + 1).toLowerCase();
}

export function isKiloOwnedEmailDomain(domain: string): boolean {
  return KILO_OWNED_DOMAINS.some(owned => domain === owned || domain.endsWith(`.${owned}`));
}

export const ActorEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .refine(email => isKiloOwnedEmailDomain(emailDomainAfterLastAt(email)));

export function parseActorEmail(value: unknown): string | null {
  const parsed = ActorEmailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function authorizeSupportRequest(request: NextRequest): NextResponse | null {
  const expected = serverConfig.SUPPORT_API_SECRET.trim();
  // Fail closed before compare: getEnvVariable returns '' and timingSafeEqual('','') is true.
  if (!expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const header = request.headers.get('Authorization');
  const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  const previous = serverConfig.SUPPORT_API_SECRET_PREVIOUS.trim();
  const matchesCurrent = secretMatches(provided, expected);
  const matchesPrevious = previous ? secretMatches(provided, previous) : false;
  if (!matchesCurrent && !matchesPrevious) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

export function hashSupportTargetEmail(email: string): string | null {
  const secret = serverConfig.SUPPORT_API_SECRET.trim();
  if (!secret) return null;
  return createHmac('sha256', secret).update(email).digest('hex');
}

export function isSupportDeletionRefused(user: {
  is_admin: boolean;
  is_super_admin: boolean;
  is_bot: boolean;
  hosted_domain: string | null;
  google_user_email: string;
}): boolean {
  if (user.is_admin || user.is_super_admin || user.is_bot) return true;
  if (user.hosted_domain === 'kilocode.ai') return true;
  return isKiloOwnedEmailDomain(emailDomainAfterLastAt(user.google_user_email));
}

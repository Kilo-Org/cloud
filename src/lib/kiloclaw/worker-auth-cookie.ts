import 'server-only';

import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import type { User } from '@/db/schema';

const COOKIE_NAME = 'kilo-worker-auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const REFRESH_THRESHOLD = 60 * 60 * 24 * 7; // refresh if <7 days remaining

export async function setWorkerAuthCookie(user: User): Promise<void> {
  const token = generateApiToken(user, undefined, { expiresIn: TOKEN_EXPIRY.thirtyDays });
  const cookieStore = await cookies();
  const isDev = process.env.NODE_ENV === 'development';
  cookieStore.set(COOKIE_NAME, token, {
    domain: isDev ? undefined : '.kilo.ai',
    path: '/',
    httpOnly: true,
    secure: !isDev,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function getWorkerAuthCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(COOKIE_NAME)?.value ?? null;
}

export async function clearWorkerAuthCookie(): Promise<void> {
  const cookieStore = await cookies();
  const isDev = process.env.NODE_ENV === 'development';
  cookieStore.set(COOKIE_NAME, '', {
    domain: isDev ? undefined : '.kilo.ai',
    path: '/',
    maxAge: 0,
  });
}

export async function isWorkerAuthCookieExpiring(): Promise<boolean> {
  const token = await getWorkerAuthCookie();
  if (!token) return true;
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (!decoded?.exp) return true;
    return decoded.exp - Math.floor(Date.now() / 1000) < REFRESH_THRESHOLD;
  } catch {
    return true;
  }
}

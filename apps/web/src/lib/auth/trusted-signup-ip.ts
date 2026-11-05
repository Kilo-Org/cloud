import 'server-only';
import { isIP } from 'node:net';

export function getTrustedSignupClientIp(headers: Headers): string | undefined {
  const localHeaders = process.env.NODE_ENV !== 'production' && !process.env.VERCEL_ENV;
  const header = process.env.VERCEL
    ? 'x-vercel-forwarded-for'
    : localHeaders
      ? 'x-forwarded-for'
      : undefined;
  if (!header) return undefined;
  const address = headers.get(header)?.split(',')[0]?.trim();
  return address && isIP(address) ? address : undefined;
}

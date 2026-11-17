import 'server-only';
import { isIP } from 'node:net';
import { firstForwardedHop } from '@kilocode/web-shared/lib/http/forwarded-hop';

export function getTrustedSignupClientIp(headers: Headers): string | undefined {
  const localHeaders = process.env.NODE_ENV !== 'production' && !process.env.VERCEL_ENV;
  const header = process.env.VERCEL
    ? 'x-vercel-forwarded-for'
    : localHeaders
      ? 'x-forwarded-for'
      : undefined;
  if (!header) return undefined;
  const address = firstForwardedHop(headers.get(header));
  return address !== null && isIP(address) ? address : undefined;
}

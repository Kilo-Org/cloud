import 'server-only';
import { headers } from 'next/headers';
import { clientIpFromHeaders } from '@kilocode/web-shared/lib/admin/admin-access-log';
import type { SignInMethodChangeRequestDetails } from '@kilocode/web-shared/lib/email';

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const OPERATING_SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\biPhone|\biPad|\biPod/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

function firstMatch(value: string, patterns: ReadonlyArray<[RegExp, string]>): string | null {
  return patterns.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

/** A short browser and operating system label, such as "Chrome on macOS". */
export function describeUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const browser = firstMatch(userAgent, BROWSERS);
  const os = firstMatch(userAgent, OPERATING_SYSTEMS);
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}

function headerValue(headersList: Headers, name: string): string | null {
  const value = headersList.get(name)?.trim();
  if (!value) return null;
  try {
    // Vercel sends the city name URL-encoded.
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** An approximate location from the Vercel or Cloudflare geolocation headers. */
export function approximateLocation(headersList: Headers): string | null {
  const city =
    headerValue(headersList, 'x-vercel-ip-city') ?? headerValue(headersList, 'cf-ipcity');
  const country =
    headerValue(headersList, 'x-vercel-ip-country') ?? headerValue(headersList, 'cf-ipcountry');
  const parts = [city, country].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

export function signInMethodChangeRequestDetails(
  headersList: Headers,
  changedAt: Date = new Date()
): SignInMethodChangeRequestDetails {
  return {
    changedAt,
    ip: clientIpFromHeaders(headersList),
    location: approximateLocation(headersList),
    device: describeUserAgent(headersList.get('user-agent')),
  };
}

/**
 * The details of the current request. Outside a request scope there are no
 * headers, so the details hold only the time.
 */
export async function currentSignInMethodChangeRequestDetails(): Promise<SignInMethodChangeRequestDetails> {
  try {
    return signInMethodChangeRequestDetails(new Headers(await headers()));
  } catch {
    return { changedAt: new Date(), ip: null, location: null, device: null };
  }
}

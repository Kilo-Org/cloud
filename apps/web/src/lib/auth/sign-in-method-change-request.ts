import 'server-only';
import { headers } from 'next/headers';
import {
  clientIpFromHeaders,
  routeFromHeaders,
} from '@kilocode/web-shared/lib/admin/admin-access-log';

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

/** An approximate location from the Vercel geolocation headers. */
export function approximateLocation(headersList: Headers): string | null {
  const city = headerValue(headersList, 'x-vercel-ip-city');
  const country = headerValue(headersList, 'x-vercel-ip-country');
  const parts = [city, country].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The client address and route of the current request, for the audit record
 * of a sign-in method change. Outside a request scope both are absent.
 */
export async function currentSignInMethodChangeAuditRequest(): Promise<{
  ip: string | null;
  route?: string;
}> {
  try {
    const headersList = new Headers(await headers());
    return {
      ip: clientIpFromHeaders(headersList),
      route: routeFromHeaders(headersList) ?? undefined,
    };
  } catch {
    return { ip: null };
  }
}

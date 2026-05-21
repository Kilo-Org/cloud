import { LANDING_URL } from '@/lib/constants';

export function buildLandingRedirectUrl(path: string, searchParams?: NextAppSearchParams): string {
  const url = new URL(path, LANDING_URL);

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) url.searchParams.append(key, item);
      }
      continue;
    }

    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}

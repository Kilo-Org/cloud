import 'server-only';

const PLACEHOLDER_ORIGIN = 'https://claude-billing.invalid';

/**
 * The path to return to after a connection, or `/byok` when the value is not a
 * same-origin path. `new URL('//host', base)` resolves to another origin, so the
 * check parses against a placeholder origin and requires it to survive.
 */
export function claudeBillingReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/byok';
  }
  try {
    const url = new URL(value, PLACEHOLDER_ORIGIN);
    return url.origin === PLACEHOLDER_ORIGIN ? `${url.pathname}${url.search}` : '/byok';
  } catch {
    return '/byok';
  }
}

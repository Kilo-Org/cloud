/** Resolve the Sentry `environment` tag from optional config + build mode. */
export function resolveSentryEnvironment(raw: string | undefined, isDev: boolean): string {
  const trimmed = raw?.trim();
  if (trimmed) {
    return trimmed;
  }
  return isDev ? 'development' : 'unknown';
}

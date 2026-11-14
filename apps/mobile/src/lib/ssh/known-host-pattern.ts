/** The OpenSSH host pattern the store keys a trusted key under. */
export function hostPattern(hostname: string, port: number): string {
  return port === 22 ? hostname : `[${hostname}]:${port}`;
}

/**
 * The OpenSSH host pattern as a reader reads it. A non-default port makes
 * OpenSSH write the host in brackets (`[web-1.kilo.test]:2222`), which is the
 * form a `known_hosts` line holds; the screen shows the plainer `host:port`
 * while the stored pattern, its accessible name and the delete dialog keep the
 * exact text.
 */
export function hostPatternDisplay(pattern: string): string {
  const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(pattern);
  if (bracketed?.[1] !== undefined) {
    return `${bracketed[1]}:${bracketed[2] ?? ''}`;
  }
  return pattern;
}

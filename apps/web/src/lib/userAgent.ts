const userAgentPrefix = 'Kilo-Code/';
export function getKiloCodeVersionNumber(userAgent: string | null | undefined): number | undefined {
  if (!userAgent || !userAgent.startsWith(userAgentPrefix)) return undefined;
  return getXKiloCodeVersionNumber(userAgent.slice(userAgentPrefix.length));
}

// The current Kilo Code extension (and Kilo CLI) send this User-Agent via the
// shared Kilo gateway headers, e.g. `opencode-kilo-provider/7.1.0`. The CLI omits
// the version, so a bare `opencode-kilo-provider` yields undefined.
const openCodeUserAgentPrefix = 'opencode-kilo-provider/';
export function getOpenCodeKiloVersionNumber(
  userAgent: string | null | undefined
): number | undefined {
  if (!userAgent || !userAgent.startsWith(openCodeUserAgentPrefix)) return undefined;
  return getXKiloCodeVersionNumber(userAgent.slice(openCodeUserAgentPrefix.length));
}
export function getXKiloCodeVersionNumber(
  userAgent: string | null | undefined
): number | undefined {
  if (!userAgent) return undefined;
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[a-zA-Z0-9.]+)?(?:\s|$)/.exec(userAgent);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = match[2] ? Number(match[2]) : 0;
  const patch = match[3] ? Number(match[3]) : 0;
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return undefined;
  return major + minor / 1000 + patch / 1_000_000;
}

const userAgentPrefix = 'Kilo-Code/';
export function getKiloCodeVersionNumber(userAgent: string | null | undefined): number | undefined {
  if (!userAgent || !userAgent.startsWith(userAgentPrefix)) return undefined;
  return getXKiloCodeVersionNumber(userAgent.slice(userAgentPrefix.length));
}

// The legacy ("Roo-based") Kilo Code extension fetches notifications with axios from
// the Node extension host, which sends `User-Agent: axios/<version>`. The current
// extension and CLI use the shared Kilo gateway headers instead (`opencode-kilo-provider/...`).
// This heuristic is only meaningful for the notifications endpoint: axios is a generic
// HTTP client (also used for LLM calls), so it is not a general "is legacy extension" signal.
export function isLegacyKiloExtensionNotificationsUserAgent(
  userAgent: string | null | undefined
): boolean {
  return !!userAgent && userAgent.startsWith('axios/');
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

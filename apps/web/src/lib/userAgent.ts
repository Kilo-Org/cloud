const userAgentPrefix = 'Kilo-Code/';
export function getKiloCodeVersionNumber(userAgent: string | null | undefined): number | undefined {
  if (!userAgent || !userAgent.startsWith(userAgentPrefix)) return undefined;
  return getXKiloCodeVersionNumber(userAgent.slice(userAgentPrefix.length));
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

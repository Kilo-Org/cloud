/**
 * Normalise a version string to a bare calver (e.g. "2026.3.8").
 *
 * Handles:
 *  - Surrounding quotes from bun build --define: `"2026.3.8"` → `2026.3.8`
 *  - Full `openclaw --version` output from older controllers:
 *    `OpenClaw 2026.3.8 (3caab92)` → `2026.3.8`
 *  - Plain calver (new controllers already strip): `2026.3.8` → `2026.3.8`
 */
export function cleanVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  // Strip surrounding quotes
  const v = version.replace(/^["']|["']$/g, '');
  // Extract bare calver if the string contains one (handles prefixed/suffixed formats)
  const match = v.match(/(\d{4}\.\d{1,2}\.\d{1,2})/);
  if (match) return match[1];
  return v || null;
}

/**
 * Returns `'modified'` when the running OpenClaw version differs from the image version,
 * indicating the user has self-updated OpenClaw on their machine.
 * Returns `null` when the versions match or there is insufficient data to compare.
 */
export function getRunningVersionBadge(
  runningVersion: string | null | undefined,
  imageVersion: string | null | undefined
): 'modified' | null {
  const running = cleanVersion(runningVersion);
  const image = cleanVersion(imageVersion);
  if (!running || !image || running === image) return null;
  return 'modified';
}

/** Returns true if calver `version` is >= `minVersion` (e.g. "2026.2.26"). Fails closed on malformed input. */
export function calverAtLeast(version: string | null | undefined, minVersion: string): boolean {
  const parts = parseCalver(version);
  const minParts = parseCalver(minVersion);
  if (!parts || !minParts) return false;

  for (let i = 0; i < minParts.length; i++) {
    const a = parts[i];
    const b = minParts[i];
    if (a > b) return true;
    if (a < b) return false;
  }

  return true;
}

function parseCalver(version: string | null | undefined): [number, number, number] | null {
  const cleaned = cleanVersion(version);
  if (!cleaned) return null;

  const match = cleaned.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return null;
  }

  return [major, minor, patch];
}

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

/** Returns true if calver `version` is >= `minVersion` (e.g. "2026.2.26"). Fails closed on malformed input. */
export function calverAtLeast(version: string | null | undefined, minVersion: string): boolean {
  if (!version) return false;

  const parts = version.split('.').map(Number);
  const minParts = minVersion.split('.').map(Number);

  for (let i = 0; i < minParts.length; i++) {
    const a = parts[i] ?? 0;
    const b = minParts[i] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (a > b) return true;
    if (a < b) return false;
  }

  return true;
}

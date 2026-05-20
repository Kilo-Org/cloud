/**
 * Normalise a version string to a bare calver (e.g. "2026.3.8" or "2026.3.8.1430").
 *
 * Handles:
 *  - Surrounding quotes from bun build --define: `"2026.3.8.1430"` → `2026.3.8.1430`
 *  - Full `openclaw --version` output from older controllers:
 *    `OpenClaw 2026.3.8 (3caab92)` → `2026.3.8`
 *  - Plain calver (new controllers already strip): `2026.3.8.1430` → `2026.3.8.1430`
 */
export function cleanVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  // Strip surrounding quotes
  const v = version.replace(/^["']|["']$/g, '');
  // Extract bare calver if the string contains one (handles prefixed/suffixed formats)
  const match = v.match(/(\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d{1,4})?)/);
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

/** Returns true if calver `version` is >= `minVersion` (e.g. "2026.2.26" or "2026.2.26.1430"). Fails closed on malformed input. */
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

/**
 * Capability gate for controller-calver-gated UI features.
 *
 * Unlike `calverAtLeast` — which fails CLOSED on missing or malformed
 * input, the correct behaviour for upgrade detection — this fails OPEN
 * for genuinely unknown versions but CLOSED for a version the worker
 * has positively reported as belonging to an old controller.
 *
 * Returns `false` when:
 *  - `version` is `null`: the worker maps a missing `/_kilo/version`
 *    route to `{ version: null }`, so an explicit `null` is not
 *    "unknown" — it is a positive "this controller is too old" signal.
 *    Treating it as supported would show the feature's UI on a
 *    known-stale controller and let a save hit the deferred
 *    `controller_route_unavailable` 404.
 *  - `version` is a well-formed calver definitively older than
 *    `minVersion`.
 *
 * Returns `true` (optimistic) when `version` is `undefined` — the query
 * is still loading, errored, or the instance is not running — or an
 * unparseable non-calver string such as a local dev build. A false
 * "upgrade required" banner on a current instance is a worse UX than
 * optimistically showing the control; the worker's 404 on save remains
 * the backstop for the rare genuinely-stale-image case.
 */
export function controllerCalverSupports(
  version: string | null | undefined,
  minVersion: string
): boolean {
  // Explicit `null` is the worker's positive old-controller signal —
  // gate the feature OFF so the UI never offers a save against a route
  // the controller does not expose.
  if (version === null) return false;
  // `undefined` (loading / errored / not-running) or an unparseable
  // dev string stays optimistic. Only a version we can positively parse
  // AND place below the threshold gates the feature off.
  if (version === undefined || !parseCalver(version)) return true;
  return calverAtLeast(version, minVersion);
}

function parseCalver(version: string | null | undefined): [number, number, number, number] | null {
  const cleaned = cleanVersion(version);
  if (!cleaned) return null;

  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const time = match[4] === undefined ? 0 : Number(match[4]);
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch) || Number.isNaN(time)) {
    return null;
  }

  return [major, minor, patch, time];
}

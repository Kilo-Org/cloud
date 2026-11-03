/**
 * Rig handle rules.
 *
 * A rig handle becomes the caller's identity inside a wasteland: it is
 * written to `claimed_by` / `posted_by` / stamp authorship, it names
 * `wl/<handle>/<item>` branches, and it is interpolated into the
 * registration DML. These helpers keep the format rule and the
 * ownership comparison in one place so the join ceremony and the
 * service adapter cannot drift apart.
 */

/** Longest handle the wasteland `rigs` schema and the join input accept. */
export const RIG_HANDLE_MAX_LENGTH = 64;

/**
 * Lowercase letters, digits, `-` and `_`. Mirrors the `joinWasteland`
 * input rule; uppercase variants of a handle are refused rather than
 * normalized so the stored identity always matches the registration.
 */
const RIG_HANDLE_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Validate a handle that is about to become a rig identity. Returns an
 * actionable message, or `null` when the handle is well formed.
 */
export function rigHandleFormatError(handle: string): string | null {
  if (handle.length === 0) return 'Rig handle is required';
  if (handle.length > RIG_HANDLE_MAX_LENGTH) {
    return `Rig handle must be at most ${RIG_HANDLE_MAX_LENGTH} characters`;
  }
  if (!RIG_HANDLE_PATTERN.test(handle)) {
    return 'Rig handle may only contain lowercase letters, digits, "-" and "_"';
  }
  return null;
}

/**
 * Whether an upstream `rigs.dolthub_org` names the caller's own DoltHub
 * org. DoltHub owner names are case-insensitive for URL paths, so the
 * comparison trims and lowercases both sides. A missing or empty stored
 * org never matches: an unowned row must not be adoptable.
 */
export function isSameDolthubOrg(storedOrg: string | null, callerOrg: string): boolean {
  const stored = (storedOrg ?? '').trim().toLowerCase();
  const caller = callerOrg.trim().toLowerCase();
  return stored.length > 0 && stored === caller;
}

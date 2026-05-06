/**
 * Shared, pure resolution of which profile(s) apply to a session.
 *
 * Used by both the server-side merge (`mergeProfileConfiguration`) and the
 * client-side profile picker UI so the two always agree on what is applied.
 */

export type AutomaticProfileSource = 'repo-binding' | 'default';

export type ResolvedProfileLayers = {
  /**
   * The automatically-applied profile (shown as the base layer in the UI and
   * merged first on the server). `null` when no binding or fallback applies.
   */
  automatic: { profileId: string; source: AutomaticProfileSource } | null;
  /**
   * The user's explicit override, if any — merged on top of `automatic`.
   * `null` when no override is selected, or when the explicit pick equals the
   * automatic profile (in which case applying it would be a no-op).
   */
  explicit: string | null;
};

export type ResolveProfileLayersInput = {
  /** The profile bound to the current repo, if any. */
  repoBindingProfileId: string | null;
  /**
   * The effective default profile for the caller (personal default beats org
   * default in an org context). Only used when nothing more specific applies.
   */
  effectiveDefaultProfileId: string | null;
  /** The profile the user explicitly selected for this task, if any. */
  explicitOverrideProfileId: string | null;
};

/**
 * Resolve which profile(s) apply for this session.
 *
 * Rules:
 *  - A repo binding always claims the automatic slot.
 *  - The effective default fills the automatic slot only when no repo binding
 *    exists **and** no explicit override is picked. Once the user picks
 *    explicitly, the default is not co-applied.
 *  - An explicit override fills the `explicit` slot, but is dropped when it
 *    matches the automatic profile (to avoid a redundant re-application).
 */
export function resolveProfileLayers({
  repoBindingProfileId,
  effectiveDefaultProfileId,
  explicitOverrideProfileId,
}: ResolveProfileLayersInput): ResolvedProfileLayers {
  let automatic: ResolvedProfileLayers['automatic'] = null;
  if (repoBindingProfileId) {
    automatic = { profileId: repoBindingProfileId, source: 'repo-binding' };
  } else if (!explicitOverrideProfileId && effectiveDefaultProfileId) {
    automatic = { profileId: effectiveDefaultProfileId, source: 'default' };
  }

  let explicit = explicitOverrideProfileId;
  if (explicit && automatic && explicit === automatic.profileId) {
    explicit = null;
  }

  return { automatic, explicit };
}

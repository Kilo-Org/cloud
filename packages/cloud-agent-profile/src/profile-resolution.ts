/**
 * Shared, pure resolution of which profile(s) apply to a session.
 *
 * Used by both the server-side merge (`mergeProfileConfiguration`) and the
 * client-side profile picker UI so the two always agree on what is applied.
 *
 * Conceptually there are up to two profile layers, applied bottom-up:
 *   - base: the repo-bound profile (when the session targets a repo with a
 *     binding). Always applied as the base when present.
 *   - top:  the user's explicit pick if they made one for this task,
 *     otherwise the effective default (personal default, falling back to the
 *     org default in an org context). The explicit pick *replaces* the
 *     default in this slot — it does not replace the repo base.
 *
 * If `top` would be the same profile as `base`, it is dropped to avoid
 * applying the same profile twice.
 */

export type ProfileLayerSource = 'repo-binding' | 'default' | 'explicit';

export type ProfileLayer = {
  profileId: string;
  source: ProfileLayerSource;
};

export type ResolvedProfileLayers = {
  /** Repo-bound profile, if any. Always the base layer when present. */
  base: ProfileLayer | null;
  /**
   * Top layer applied on top of `base`. Filled by the explicit pick if any,
   * otherwise by the effective default. `null` when neither applies, or when
   * it would duplicate the base (same profile id).
   */
  top: ProfileLayer | null;
};

export type ResolveProfileLayersInput = {
  /** The profile bound to the current repo, if any. */
  repoBindingProfileId: string | null;
  /**
   * The effective default profile for the caller (personal default beats org
   * default in an org context). Used when no explicit pick was made.
   */
  effectiveDefaultProfileId: string | null;
  /** The profile the user explicitly selected for this task, if any. */
  explicitOverrideProfileId: string | null;
};

/**
 * Resolve which profile(s) apply for this session.
 *
 * Rules:
 *  - A repo binding always claims the `base` slot.
 *  - The `top` slot is the explicit pick if any, else the effective default.
 *  - `top` is dropped when it equals `base` to avoid applying the same
 *    profile twice.
 */
export function resolveProfileLayers({
  repoBindingProfileId,
  effectiveDefaultProfileId,
  explicitOverrideProfileId,
}: ResolveProfileLayersInput): ResolvedProfileLayers {
  const base: ProfileLayer | null = repoBindingProfileId
    ? { profileId: repoBindingProfileId, source: 'repo-binding' }
    : null;

  let top: ProfileLayer | null = null;
  if (explicitOverrideProfileId) {
    top = { profileId: explicitOverrideProfileId, source: 'explicit' };
  } else if (effectiveDefaultProfileId) {
    top = { profileId: effectiveDefaultProfileId, source: 'default' };
  }

  if (top && base && top.profileId === base.profileId) {
    top = null;
  }

  return { base, top };
}

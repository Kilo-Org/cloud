/**
 * Pure resolution of the session-start profile picker: which profile is shown,
 * which one is submitted, and which rows the picker offers.
 *
 * Mirrors the shared `resolveProfileLayers` in
 * `@kilocode/cloud-agent-profile` — the same two-layer merge the server and the
 * web picker use. Mobile cannot import that package directly (it is a
 * dev-dependency of `@kilocode/trpc`, and the mobile tRPC entry is type-only),
 * so the rules are restated here with the same outcomes: a repo binding always
 * claims the base slot, the explicit pick fills the top slot and replaces the
 * effective default, and a top that duplicates the base is dropped.
 */

export type ProfileLayerSource = 'repo-binding' | 'default' | 'explicit';

/** One profile as the picker and the chip render it. */
export type SessionProfilePickerProfile = {
  id: string;
  name: string;
  varCount: number;
  mcpServerCount: number;
  skillCount: number;
  kiloCommandCount: number;
};

export type SessionProfilePickerInput<
  P extends SessionProfilePickerProfile = SessionProfilePickerProfile,
> = {
  profiles: readonly P[];
  /** The profile bound to the target repo, when the caller knows it. */
  repoBindingProfileId: string | null;
  /** The effective default for the context (personal default beats org default). */
  effectiveDefaultProfileId: string | null;
  /** The profile the user picked for this task, or null for the default. */
  selectedOverrideProfileId: string | null;
};

export type SessionProfilePickerState<
  P extends SessionProfilePickerProfile = SessionProfilePickerProfile,
> = {
  /** The repo-bound profile, when present. */
  baseProfile: P | null;
  /** The applied top layer: the explicit pick, else the effective default. */
  topProfile: P | null;
  /** The active profile's name, or null when no profile applies. */
  chipName: string | null;
  /** `N vars · N MCP · N skills · N cmds` for the active layer pair, or ''. */
  chipCounts: string;
  /** Where the top layer came from, or null when none applies. */
  topSource: ProfileLayerSource | null;
  /** True when the top layer is the user's explicit pick. */
  hasOverride: boolean;
  /** The id the create call should submit: the valid override, else the default. */
  selectedProfileId: string | null;
  /**
   * True when the user picked an override that no longer resolves to a
   * profile. The screen shows attention and submits with no override id.
   */
  overrideNeedsAttention: boolean;
  /** Rows the picker offers: every profile except the base. */
  candidates: P[];
};

/** The three candidate ids the layer resolver weighs. */
export type SessionProfileLayerIdsInput = {
  repoBindingProfileId: string | null;
  effectiveDefaultProfileId: string | null;
  explicitOverrideProfileId: string | null;
};

/** The resolved two-layer stack, as ids. */
export type SessionProfileLayerIds = {
  baseProfileId: string | null;
  topProfileId: string | null;
  topSource: ProfileLayerSource | null;
};

/**
 * Resolve the repo base and the top layer from the three candidate ids,
 * dropping a top that duplicates the base (the shared resolver's rule).
 */
export function resolveSessionProfileLayerIds({
  repoBindingProfileId,
  effectiveDefaultProfileId,
  explicitOverrideProfileId,
}: Readonly<SessionProfileLayerIdsInput>): SessionProfileLayerIds {
  const baseProfileId = repoBindingProfileId;
  let topProfileId: string | null = null;
  let topSource: ProfileLayerSource | null = null;
  if (explicitOverrideProfileId) {
    topProfileId = explicitOverrideProfileId;
    topSource = 'explicit';
  } else if (effectiveDefaultProfileId) {
    topProfileId = effectiveDefaultProfileId;
    topSource = 'default';
  }
  if (topProfileId && baseProfileId && topProfileId === baseProfileId) {
    topProfileId = null;
    topSource = null;
  }
  return { baseProfileId, topProfileId, topSource };
}

/**
 * `N vars · N MCP · N skills · N cmds` for a single profile, omitting zero
 * counts. Used by the picker rows.
 */
export function formatSessionProfileCounts(profile: SessionProfilePickerProfile): string {
  return [
    profile.varCount > 0 && `${profile.varCount} vars`,
    profile.mcpServerCount > 0 && `${profile.mcpServerCount} MCP`,
    profile.skillCount > 0 && `${profile.skillCount} skills`,
    profile.kiloCommandCount > 0 && `${profile.kiloCommandCount} cmds`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The active pair's counts: vars take the larger layer (they merge), MCP,
 * skills and commands add. Matches the web chip's arithmetic.
 */
function formatActiveCounts(
  base: SessionProfilePickerProfile | null,
  top: SessionProfilePickerProfile | null
): string {
  const vars = Math.max(base?.varCount ?? 0, top?.varCount ?? 0);
  const mcps = (base?.mcpServerCount ?? 0) + (top?.mcpServerCount ?? 0);
  const skills = (base?.skillCount ?? 0) + (top?.skillCount ?? 0);
  const cmds = (base?.kiloCommandCount ?? 0) + (top?.kiloCommandCount ?? 0);
  return [
    vars > 0 && `${vars} vars`,
    mcps > 0 && `${mcps} MCP`,
    skills > 0 && `${skills} skills`,
    cmds > 0 && `${cmds} cmds`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function resolveSessionProfilePicker<P extends SessionProfilePickerProfile>(
  input: SessionProfilePickerInput<P>
): SessionProfilePickerState<P> {
  const { profiles } = input;
  const { baseProfileId, topProfileId, topSource } = resolveSessionProfileLayerIds({
    repoBindingProfileId: input.repoBindingProfileId,
    effectiveDefaultProfileId: input.effectiveDefaultProfileId,
    explicitOverrideProfileId: input.selectedOverrideProfileId,
  });

  const baseProfile =
    baseProfileId === null
      ? null
      : (profiles.find(profile => profile.id === baseProfileId) ?? null);
  const topProfile =
    topProfileId === null ? null : (profiles.find(profile => profile.id === topProfileId) ?? null);

  // The user picked an id the list does not contain: never submit it again.
  const overrideNeedsAttention =
    input.selectedOverrideProfileId !== null && topProfile === null && topSource === 'explicit';

  const selectedProfileId = overrideNeedsAttention
    ? null
    : (topProfile?.id ?? baseProfile?.id ?? null);

  return {
    baseProfile,
    topProfile,
    chipName: topProfile?.name ?? baseProfile?.name ?? null,
    chipCounts: formatActiveCounts(baseProfile, topProfile),
    topSource,
    hasOverride: topSource === 'explicit' && topProfile !== null,
    selectedProfileId,
    overrideNeedsAttention,
    candidates: profiles.filter(profile => profile.id !== baseProfile?.id),
  };
}

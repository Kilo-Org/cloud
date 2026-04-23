/**
 * Town configuration management.
 */

import {
  TownConfigSchema,
  type TownConfig,
  type TownConfigUpdate,
  type MergeStrategy,
  type RigOverrideConfig,
} from '../../types';

const CONFIG_KEY = 'town:config';
const NEW_TOWN_DEFAULTS_SEEDED_KEY = 'town:config:newDefaultsSeeded';

const TOWN_LOG = '[Town.do]';

/**
 * Defaults that were introduced for NEW towns in #2725 but that must NOT
 * be retroactively applied to existing persisted configs (doing so would
 * silently flip production behavior for every town that pre-dates the change).
 *
 * These are seeded exactly once per town, the first time a Town DO loads
 * its config and finds nothing persisted (fresh create) AND has not already
 * been seeded. Seeded state is tracked under a separate key so that legacy
 * towns which have _other_ config saved but never touched these fields do
 * not get silently rewritten on next load.
 */
const NEW_TOWN_CONFIG_DEFAULTS = {
  merge_strategy: 'pr' as const,
  staged_convoys_default: true,
  refinery: {
    gates: [] as string[],
    auto_merge: true,
    require_clean_merge: true,
    code_review: true,
    review_mode: 'comments' as const,
    auto_resolve_pr_feedback: true,
    auto_merge_delay_minutes: 5 as number | null,
  },
};

export async function getTownConfig(storage: DurableObjectStorage): Promise<TownConfig> {
  const raw = await storage.get<unknown>(CONFIG_KEY);
  if (!raw) {
    // Fresh town: seed the new-style defaults from #2725 and persist so they
    // become the town's actual config (rather than schema-injected defaults
    // on every read). This keeps new-town behavior modern while leaving
    // legacy towns — which already have a persisted row — untouched.
    const seeded = TownConfigSchema.parse(NEW_TOWN_CONFIG_DEFAULTS);
    await storage.put(CONFIG_KEY, seeded);
    await storage.put(NEW_TOWN_DEFAULTS_SEEDED_KEY, true);
    return seeded;
  }
  return TownConfigSchema.parse(raw);
}

export async function updateTownConfig(
  storage: DurableObjectStorage,
  update: TownConfigUpdate
): Promise<TownConfig> {
  const current = await getTownConfig(storage);

  // env_vars: full replacement semantics. Masked values (exactly "****" followed
  // by up to 4 reveal chars) from the server's masking layer are preserved to
  // avoid overwriting secrets.
  const MASKED_RE = /^\*{4}.{0,4}$/;
  let resolvedEnvVars = current.env_vars;
  if (update.env_vars) {
    resolvedEnvVars = {};
    for (const [key, value] of Object.entries(update.env_vars)) {
      resolvedEnvVars[key] = MASKED_RE.test(value) ? (current.env_vars[key] ?? value) : value;
    }
  }

  // git_auth: preserve masked token values (starting with "****") to avoid
  // overwriting real secrets when the UI round-trips masked config.
  let resolvedGitAuth = current.git_auth;
  if (update.git_auth) {
    resolvedGitAuth = { ...current.git_auth };
    for (const key of ['github_token', 'gitlab_token', 'gitlab_instance_url'] as const) {
      const incoming = update.git_auth[key];
      if (incoming === undefined) continue;
      resolvedGitAuth[key] = MASKED_RE.test(incoming)
        ? (current.git_auth[key] ?? incoming)
        : incoming;
    }
    // platform_integration_id is not masked — always take the update value
    if (update.git_auth.platform_integration_id !== undefined) {
      resolvedGitAuth.platform_integration_id = update.git_auth.platform_integration_id;
    }
  }

  // github_cli_pat: same mask-preservation as git_auth tokens
  const resolvedGithubCliPat =
    update.github_cli_pat !== undefined
      ? MASKED_RE.test(update.github_cli_pat)
        ? current.github_cli_pat
        : update.github_cli_pat
      : current.github_cli_pat;

  // Normalize empty-string model fields to undefined so resolveModel()'s
  // nullish-coalescing fallback works correctly when the user clears them.
  const resolvedDefaultModel =
    update.default_model !== undefined ? update.default_model || undefined : current.default_model;

  const merged: TownConfig = {
    ...current,
    ...update,
    env_vars: resolvedEnvVars,
    git_auth: resolvedGitAuth,
    github_cli_pat: resolvedGithubCliPat,
    default_model: resolvedDefaultModel,
    refinery:
      update.refinery !== undefined
        ? {
            gates: update.refinery.gates ?? current.refinery?.gates ?? [],
            auto_merge: update.refinery.auto_merge ?? current.refinery?.auto_merge ?? true,
            require_clean_merge:
              update.refinery.require_clean_merge ?? current.refinery?.require_clean_merge ?? true,
            code_review: update.refinery.code_review ?? current.refinery?.code_review ?? true,
            review_mode: update.refinery.review_mode ?? current.refinery?.review_mode ?? 'rework',
            auto_resolve_pr_feedback:
              update.refinery.auto_resolve_pr_feedback ??
              current.refinery?.auto_resolve_pr_feedback ??
              false,
            auto_resolve_merge_conflicts:
              update.refinery.auto_resolve_merge_conflicts ??
              current.refinery?.auto_resolve_merge_conflicts ??
              true,
            auto_merge_delay_minutes:
              update.refinery.auto_merge_delay_minutes !== undefined
                ? update.refinery.auto_merge_delay_minutes
                : (current.refinery?.auto_merge_delay_minutes ?? null),
          }
        : current.refinery,
    container:
      update.container !== undefined
        ? {
            sleep_after_minutes:
              update.container.sleep_after_minutes ?? current.container?.sleep_after_minutes,
          }
        : current.container,
    custom_instructions:
      update.custom_instructions !== undefined
        ? {
            polecat:
              'polecat' in update.custom_instructions
                ? update.custom_instructions.polecat
                : current.custom_instructions?.polecat,
            refinery:
              'refinery' in update.custom_instructions
                ? update.custom_instructions.refinery
                : current.custom_instructions?.refinery,
            mayor:
              'mayor' in update.custom_instructions
                ? update.custom_instructions.mayor
                : current.custom_instructions?.mayor,
          }
        : current.custom_instructions,
  };

  const validated = TownConfigSchema.parse(merged);
  await storage.put(CONFIG_KEY, validated);
  console.log(
    `${TOWN_LOG} updateTownConfig: saved config with ${Object.keys(validated.env_vars).length} env vars`
  );
  return validated;
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

/**
 * Resolve the primary model from town config, optionally applying a rig override.
 * Priority: rig override (role-specific) → rig override (default) → town role-specific → town default → hardcoded default.
 */
export function resolveModel(
  townConfig: TownConfig,
  rigOverride: RigOverrideConfig | null | undefined,
  role: string
): string {
  const base = rigOverride?.default_model ?? townConfig.default_model;
  if (role === 'mayor')
    return townConfig.role_models?.mayor ?? townConfig.default_model ?? DEFAULT_MODEL;
  if (role === 'polecat')
    return (
      rigOverride?.role_models?.polecat ?? townConfig.role_models?.polecat ?? base ?? DEFAULT_MODEL
    );
  if (role === 'refinery')
    return (
      rigOverride?.role_models?.refinery ??
      townConfig.role_models?.refinery ??
      base ??
      DEFAULT_MODEL
    );
  return base ?? DEFAULT_MODEL;
}

/**
 * Resolve the small (lightweight) model from town config.
 * Used for title generation, explore subagent, etc.
 */
export function resolveSmallModel(townConfig: TownConfig): string {
  return townConfig.small_model ?? 'anthropic/claude-haiku-4.5';
}

/**
 * Resolve the effective merge strategy for a rig.
 * Priority: rig-level override → town-level default → 'direct'.
 */
export function resolveMergeStrategy(
  townConfig: TownConfig,
  rigMergeStrategy: MergeStrategy | undefined
): MergeStrategy {
  return rigMergeStrategy ?? townConfig.merge_strategy;
}

/**
 * The fully-resolved configuration for a rig dispatch.
 * All fields have concrete values (no optional/undefined) except where
 * a null value is meaningful (e.g. auto_merge_delay_minutes: null = disabled).
 */
export type EffectiveConfig = {
  default_model: string | undefined;
  role_models: {
    polecat: string | undefined;
    refinery: string | undefined;
    mayor: string | undefined;
  };
  review_mode: 'rework' | 'comments';
  code_review: boolean;
  auto_resolve_pr_feedback: boolean;
  auto_resolve_merge_conflicts: boolean;
  auto_merge_delay_minutes: number | null;
  merge_strategy: MergeStrategy;
  convoy_merge_mode: 'review-then-land' | 'review-and-merge';
  custom_instructions: {
    polecat: string | undefined;
    refinery: string | undefined;
    mayor: string | undefined;
  };
  git_push_flags: string | undefined;
  max_concurrent_polecats: number | undefined;
  max_dispatch_attempts: number | undefined;
};

/**
 * Merge a rig's override config on top of town config, returning a fully
 * resolved EffectiveConfig for dispatch. When rigOverride is null/undefined,
 * all values fall back to town-level defaults (behavior identical to today).
 */
export function resolveRigConfig(
  townConfig: TownConfig,
  rigOverride: RigOverrideConfig | null | undefined
): EffectiveConfig {
  return {
    default_model: rigOverride?.default_model ?? townConfig.default_model,
    role_models: {
      polecat: rigOverride?.role_models?.polecat ?? townConfig.role_models?.polecat,
      refinery: rigOverride?.role_models?.refinery ?? townConfig.role_models?.refinery,
      // mayor is always town-level — rigs cannot override mayor model
      mayor: townConfig.role_models?.mayor,
    },
    review_mode: rigOverride?.review_mode ?? townConfig.refinery?.review_mode ?? 'rework',
    code_review: rigOverride?.code_review ?? townConfig.refinery?.code_review ?? true,
    auto_resolve_pr_feedback:
      rigOverride?.auto_resolve_pr_feedback ??
      townConfig.refinery?.auto_resolve_pr_feedback ??
      false,
    auto_resolve_merge_conflicts:
      rigOverride?.auto_resolve_merge_conflicts ??
      townConfig.refinery?.auto_resolve_merge_conflicts ??
      true,
    auto_merge_delay_minutes:
      rigOverride?.auto_merge_delay_minutes !== undefined
        ? rigOverride.auto_merge_delay_minutes
        : (townConfig.refinery?.auto_merge_delay_minutes ?? null),
    merge_strategy: rigOverride?.merge_strategy ?? townConfig.merge_strategy ?? 'direct',
    convoy_merge_mode:
      rigOverride?.convoy_merge_mode ?? townConfig.convoy_merge_mode ?? 'review-then-land',
    custom_instructions: {
      polecat: rigOverride?.custom_instructions?.polecat ?? townConfig.custom_instructions?.polecat,
      refinery:
        rigOverride?.custom_instructions?.refinery ?? townConfig.custom_instructions?.refinery,
      // mayor is always town-level
      mayor: townConfig.custom_instructions?.mayor,
    },
    git_push_flags: rigOverride?.git_push_flags,
    max_concurrent_polecats:
      rigOverride?.max_concurrent_polecats ?? townConfig.max_polecats_per_rig,
    max_dispatch_attempts: rigOverride?.max_dispatch_attempts,
  };
}

/**
 * Build the ContainerConfig payload for X-Town-Config header.
 * Sent with every fetch() to the container.
 */
export async function buildContainerConfig(
  storage: DurableObjectStorage,
  env: Env
): Promise<Record<string, unknown>> {
  const config = await getTownConfig(storage);
  return {
    env_vars: config.env_vars,
    default_model: resolveModel(config, null, ''),
    small_model: resolveSmallModel(config),
    git_auth: config.git_auth,
    kilocode_token: config.kilocode_token,
    github_cli_pat: config.github_cli_pat,
    git_author_name: config.git_author_name,
    git_author_email: config.git_author_email,
    disable_ai_coauthor: config.disable_ai_coauthor,
    kilo_api_url: env.KILO_API_URL ?? '',
    gastown_api_url: env.GASTOWN_API_URL ?? '',
    organization_id: config.organization_id,
  };
}

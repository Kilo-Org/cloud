/**
 * Pure helpers for agent-mode normalization and custom-mode picker options.
 *
 * This module must stay free of Lucide and React Native imports so the
 * send-path callers and the Node-based unit tests can import it without
 * pulling in the React Native tree. `mode-options.ts` (Lucide-only) re-exports
 * `normalizeAgentMode` and `ModeOption` from here.
 */

/** The built-in agent mode slugs. */
export type BuiltinAgentMode = 'code' | 'plan' | 'debug' | 'orchestrator' | 'ask';

/**
 * A valid mode for a session: a built-in slug or any custom profile-agent
 * slug. `(string & {})` keeps the built-in literal completions while still
 * accepting custom slugs (same shape as `apps/web` `cloud-agent-next/types.ts`).
 */
// oxlint-disable-next-line typescript-eslint/ban-types -- `(string & {})` keeps built-in literal completions while accepting custom slugs (same as web)
export type AgentMode = BuiltinAgentMode | (string & {});

/** One row in the mode picker. */
export type ModeOption = {
  value: AgentMode;
  label: string;
  description: string;
};

/** Structural shape of a profile agent (from `agentProfiles.get`). */
type ProfileAgent = {
  slug: string;
  name: string;
  config: {
    description?: string | null;
    mode?: string | null;
    model?: string | null;
    variant?: string | null;
    hidden?: boolean;
    disable?: boolean;
  };
};

/** Structural shape of a session `runtimeAgents` entry. */
type RuntimeAgent = {
  slug: string;
  name: string;
  model?: string;
  variant?: string;
};

const BUILTIN_MODE_SET: ReadonlySet<string> = new Set([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
]);

/** True when `value` is one of the five built-in slugs. */
export function isBuiltinAgentMode(value: AgentMode): value is BuiltinAgentMode {
  return BUILTIN_MODE_SET.has(value);
}

/**
 * Normalize a raw mode slug to a valid `AgentMode`.
 *
 * Aliases `build` → `code` and `architect` → `plan`. Any other non-empty slug
 * passes through unchanged (so a custom profile-agent slug survives). Null,
 * undefined, or an empty string becomes `code`.
 */
export function normalizeAgentMode(mode: string | null | undefined): AgentMode {
  if (mode === 'build') {
    return 'code';
  }
  if (mode === 'architect') {
    return 'plan';
  }
  if (!mode) {
    return 'code';
  }
  return mode;
}

/**
 * Filter profile agents to those that would surface in the chat picker:
 * not disabled, not hidden, and not subagent-only. Matches web's
 * `NewSessionPanel` filter.
 */
export function visibleProfileAgents(agents: ProfileAgent[]): ProfileAgent[] {
  return agents.filter(a => !a.config.disable && !a.config.hidden && a.config.mode !== 'subagent');
}

/** Map profile agents to picker options. */
export function customModeOptionsFromProfileAgents(agents: ProfileAgent[]): ModeOption[] {
  return agents.map(a => ({
    value: a.slug,
    label: a.name,
    description: a.config.description ?? '',
  }));
}

/** Map session `runtimeAgents` to picker options. Empty when missing or empty. */
export function customModeOptionsFromRuntimeAgents(
  runtimeAgents: RuntimeAgent[] | undefined
): ModeOption[] {
  if (!runtimeAgents || runtimeAgents.length === 0) {
    return [];
  }
  return runtimeAgents.map(a => ({
    value: a.slug,
    label: a.name,
    description: '',
  }));
}

/** Drop custom options whose value collides with a built-in slug. */
export function dedupeCustomModeOptions(custom: ModeOption[]): ModeOption[] {
  return custom.filter(o => !isBuiltinAgentMode(o.value));
}

/**
 * Append the selected slug once when it is neither a built-in nor already in
 * the custom list, so a prefill or inherited custom slug stays visible.
 */
export function ensureSelectedCustomOption(
  custom: ModeOption[],
  selected: AgentMode
): ModeOption[] {
  if (isBuiltinAgentMode(selected) || custom.some(o => o.value === selected)) {
    return custom;
  }
  return [...custom, { value: selected, label: selected, description: '' }];
}

/** Trim a possibly-null model/variant to `undefined` when empty. */
function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

/**
 * Resolve the model + variant pinned by the agent whose slug matches, plus the
 * agent's display name. Profile agents win over session `runtimeAgents`. A
 * variant is only returned when a model is pinned (variants are model-specific).
 */
export function resolvePinnedAgentModel(input: {
  slug: string;
  profileAgents?: ProfileAgent[];
  runtimeAgents?: RuntimeAgent[];
}): { model?: string; variant?: string; agentName?: string } {
  const profileAgent = input.profileAgents?.find(a => a.slug === input.slug);
  const runtimeAgent = input.runtimeAgents?.find(a => a.slug === input.slug);

  const rawModel = profileAgent ? profileAgent.config.model : runtimeAgent?.model;
  const model = trimToUndefined(rawModel);
  const rawVariant = profileAgent ? profileAgent.config.variant : runtimeAgent?.variant;
  const variant = model ? trimToUndefined(rawVariant) : undefined;
  const agentName = profileAgent?.name ?? runtimeAgent?.name;

  return {
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
    ...(agentName ? { agentName } : {}),
  };
}

/**
 * Build a `SessionModelOption`-compatible option for a pinned model so the
 * model chip can show the locked model id even when it is not in the catalog.
 */
export function lockedModelOption(pinned: { model?: string; variant?: string }): {
  id: string;
  name: string;
  displayId: string;
  variants: string[];
  isPreferred: false;
  showGatewayMetadata: true;
} {
  const model = pinned.model ?? '';
  return {
    id: model,
    name: model,
    displayId: model,
    variants: pinned.variant ? [pinned.variant] : [],
    isPreferred: false,
    showGatewayMetadata: true,
  };
}

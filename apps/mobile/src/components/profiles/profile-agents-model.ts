/**
 * Pure view-model helpers for the profile agents screen.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-agents-model.test.ts`. The screen owns rendering and the
 * network calls; this module owns the row projection, the add/edit form state,
 * the client-side validation that runs before a `createAgent`/`updateAgent`,
 * and the agent config the mutations send.
 *
 * Ported from the web editor (`ProfileAgentsTab.tsx`): the same reserved slugs,
 * the same disableable tool list, and the same rule that a permission map is
 * preserved except for the tools the user explicitly switches off.
 */

import { type AgentProfileDetail } from '@/lib/hooks/agent-profile-types';

/**
 * Built-in agent slugs reserved by cloud-agent-next. Mirrors
 * `BUILTIN_AGENT_SLUGS` in `@kilocode/cloud-agent-profile`; the mobile app does
 * not depend on that server package, so the set is repeated here. The server
 * rejects a create or rename that collides, so the form refuses it first.
 */
const BUILTIN_AGENT_SLUGS = new Set([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
]);

/**
 * Tools the UI exposes as disableable per agent. Cloud sessions allow every
 * tool by default; the only customization surfaced is "turn this tool off",
 * which emits `deny`. Mirrors `PERMISSION_TOOLS` in the web editor.
 */
export const PERMISSION_TOOLS: readonly string[] = [
  'read',
  'edit',
  'bash',
  'glob',
  'grep',
  'list',
  'task',
  'skill',
  'webfetch',
  'websearch',
  'codesearch',
  'mcp',
];

/** The agent config exactly as `agentProfiles.get` returns it. */
type ProfileAgentConfig = AgentProfileDetail['agents'][number]['config'];

export type AgentVisibility = NonNullable<ProfileAgentConfig['mode']>;

/**
 * The permission map an agent config carries. Derived from the tRPC output, so
 * the CLI's bare-action shorthand (`allow`/`ask`/`deny`) is part of the union
 * alongside the per-tool map; `null` is accepted defensively for hand-built
 * values.
 */
export type AgentPermissionMap = ProfileAgentConfig['permission'] | null;

/** The fields of an agent the screen reads. Structural, so tests are easy. */
export type AgentSource = Readonly<{
  id: string;
  slug: string;
  name: string;
  config: ProfileAgentConfig;
}>;

/** One agent row as the screen renders it. */
export type AgentRow = Readonly<{
  id: string;
  slug: string;
  name: string;
  visibility: AgentVisibility;
  description: string;
  model: string;
}>;

/** Project the profile's agents into the rows the list renders. */
export function agentRows(agents: readonly AgentSource[]): AgentRow[] {
  return agents.map(agent => ({
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    visibility: agent.config.mode ?? 'primary',
    description: agent.config.description ?? '',
    model: agent.config.model ?? '',
  }));
}

/**
 * The per-tool map when the value is one, or an empty map when the permission
 * is the CLI's bare-action shorthand (`allow`/`ask`/`deny`) or absent. Mirrors
 * the web editor's `typeof permission !== 'object'` guard: a bare action means
 * "every tool at this level" and carries no per-tool rules.
 */
function permissionMapOf(permission: AgentPermissionMap): Readonly<Record<string, unknown>> {
  if (
    permission == null ||
    permission === 'allow' ||
    permission === 'ask' ||
    permission === 'deny'
  ) {
    return {};
  }
  return permission;
}

/**
 * The tools denied for this agent. Only a simple string rule of `deny` counts;
 * per-pattern maps and other actions are left alone, matching the web editor.
 */
export function readDisabledTools(permission: AgentPermissionMap): string[] {
  const map = permissionMapOf(permission);
  return PERMISSION_TOOLS.filter(tool => map[tool] === 'deny');
}

/**
 * Apply the UI's disable toggles onto the existing permission map, preserving
 * any per-pattern rules and unrelated tool keys. Toggling a tool off writes
 * `deny`; toggling it back on clears a simple string rule but leaves a
 * per-pattern map alone. An empty result becomes `undefined` so the config
 * carries no empty permission object.
 */
export function mergePermissions(
  existing: AgentPermissionMap,
  disabledTools: readonly string[]
): Record<string, unknown> | undefined {
  const base = new Map(Object.entries(permissionMapOf(existing)));
  for (const tool of PERMISSION_TOOLS) {
    if (disabledTools.includes(tool)) {
      base.set(tool, 'deny');
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- permission values are an open rule union; a string arm is the only clearable one
    } else if (typeof base.get(tool) === 'string') {
      base.delete(tool);
    }
  }
  return base.size > 0 ? Object.fromEntries(base) : undefined;
}

/** The add/edit form fields. Every numeric field is text; blank means "inherit". */
export type AgentFormState = Readonly<{
  slug: string;
  name: string;
  description: string;
  prompt: string;
  visibility: AgentVisibility;
  model: string;
  steps: string;
  temperature: string;
  topP: string;
  variant: string;
  disabledTools: readonly string[];
}>;

/** Render an optional config number as form text, so blank means "not set". */
function numberToField(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** Seed the form from the agent being edited, or blank defaults for an add. */
export function initialAgentFormState(agent?: AgentSource): AgentFormState {
  if (agent === undefined) {
    return {
      slug: '',
      name: '',
      description: '',
      prompt: '',
      visibility: 'primary',
      model: '',
      steps: '',
      temperature: '',
      topP: '',
      variant: '',
      disabledTools: [],
    };
  }
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.config.description ?? '',
    prompt: agent.config.prompt ?? '',
    visibility: agent.config.mode ?? 'primary',
    model: agent.config.model ?? '',
    steps: numberToField(agent.config.steps),
    temperature: numberToField(agent.config.temperature),
    topP: numberToField(agent.config.top_p),
    variant: agent.config.variant ?? '',
    disabledTools: readDisabledTools(agent.config.permission),
  };
}

const AGENT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export type AgentFormError = 'slug-required' | 'slug-invalid' | 'slug-conflict' | 'name-required';

/**
 * Validate the form before a save. Returns the field at fault, or `null` when
 * valid. Mirrors the server's `agentSlugSchema`/`agentNameSchema`: a non-empty
 * display name, and a slug that starts with a lowercase letter, stays in
 * `[a-z0-9-]`, and does not collide with a built-in agent.
 */
export function validateAgentForm(state: AgentFormState): AgentFormError | null {
  const slug = state.slug.trim();
  if (slug.length === 0) {
    return 'slug-required';
  }
  if (!AGENT_SLUG_PATTERN.test(slug)) {
    return 'slug-invalid';
  }
  if (BUILTIN_AGENT_SLUGS.has(slug)) {
    return 'slug-conflict';
  }
  if (state.name.trim().length === 0) {
    return 'name-required';
  }
  return null;
}

/** The config shape the agent mutations send; mirrors the server's `AgentConfigSchema`. */
type AgentConfigPayload = Record<string, unknown>;

/** The payload the agent mutations send. */
export type AgentPayload = {
  slug: string;
  name: string;
  config: AgentConfigPayload;
};

/** A trimmed blank string is "inherit"; otherwise the finite float it parses to. */
function parseNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A blank, non-numeric, zero, or negative step count is "inherit". */
function parseInt10(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Build the mutation payload from a validated form. Only call after
 * `validateAgentForm` returns `null`.
 *
 * The agent's existing config is spread first, so fields the form does not
 * surface (hidden/disable flags, `color`) survive an edit. Sampling fields
 * mirror web: a blank string clears the override, `steps` only when it is a
 * positive integer. The effort variant is dropped when the model it belongs to
 * is cleared or changed — the server rejects a variant without a matching model.
 */
export function buildAgentPayload(
  state: AgentFormState,
  existing?: AgentSource['config']
): AgentPayload {
  const model = state.model.trim();
  const variant = state.variant.trim();
  const keepVariant =
    variant.length > 0 && model.length > 0 && (existing === undefined || existing.model === model);
  const config = {
    ...existing,
    prompt: state.prompt.trim() || undefined,
    description: state.description.trim() || undefined,
    mode: state.visibility,
    model: model.length > 0 ? model : undefined,
    temperature: parseNumber(state.temperature),
    top_p: parseNumber(state.topP),
    steps: parseInt10(state.steps),
    permission: mergePermissions(existing?.permission, state.disabledTools),
  } satisfies AgentConfigPayload;
  if (keepVariant) {
    config.variant = variant;
  } else {
    delete config.variant;
  }
  return { slug: state.slug.trim(), name: state.name.trim(), config };
}

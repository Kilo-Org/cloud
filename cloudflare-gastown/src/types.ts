import { z } from 'zod';
import type { BeadRecord } from './db/tables/beads.table';
import type { AgentMetadataRecord } from './db/tables/agent-metadata.table';

// -- Beads --

export const BeadStatus = z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']);
export type BeadStatus = z.infer<typeof BeadStatus>;

export const BeadType = z.enum([
  'issue',
  'message',
  'escalation',
  'merge_request',
  'convoy',
  'molecule',
  'agent',
]);
export type BeadType = z.infer<typeof BeadType>;

export const BeadPriority = z.enum(['low', 'medium', 'high', 'critical']);
export type BeadPriority = z.infer<typeof BeadPriority>;

export type Bead = BeadRecord;

export type CreateBeadInput = {
  type: BeadType;
  title: string;
  body?: string;
  priority?: BeadPriority;
  labels?: string[];
  metadata?: Record<string, unknown>;
  assignee_agent_bead_id?: string;
  parent_bead_id?: string;
  rig_id?: string;
  created_by?: string;
};

export type BeadFilter = {
  status?: BeadStatus;
  type?: BeadType;
  assignee_agent_bead_id?: string;
  parent_bead_id?: string;
  rig_id?: string;
  limit?: number;
  offset?: number;
};

// -- Agents (now beads + agent_metadata) --

export const AgentRole = z.enum(['polecat', 'refinery', 'mayor']);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentStatus = z.enum(['idle', 'working', 'waiting', 'stalled', 'dead']);
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * An Agent is a bead (type='agent') joined with its agent_metadata row.
 * This combined type is used throughout the codebase.
 */
export type Agent = {
  /** The agent's bead_id (primary key across both tables) */
  id: string;
  rig_id: string | null;
  role: AgentMetadataRecord['role'];
  name: string;
  identity: string;
  status: AgentMetadataRecord['status'];
  current_hook_bead_id: string | null;
  dispatch_attempts: number;
  last_activity_at: string | null;
  // Opaque JSON blob from SQLite; `unknown` breaks Cloudflare's Rpc.Serializable<T> type
  // inference, and recursive JSON types cause "excessively deep" instantiation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkpoint: any;
  created_at: string;
  agent_status_message: string | null;
  agent_status_updated_at: string | null;
};

export type RegisterAgentInput = {
  role: AgentRole;
  name: string;
  identity: string;
  rig_id?: string;
};

export type AgentFilter = {
  role?: AgentRole;
  status?: AgentStatus;
  rig_id?: string;
};

// -- Mail (now beads with type='message') --

export type Mail = {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  body: string;
  delivered: boolean;
  created_at: string;
  delivered_at: string | null;
};

export type SendMailInput = {
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  body: string;
};

// -- Review Queue (now beads with type='merge_request' + review_metadata) --

export const ReviewStatus = z.enum(['pending', 'running', 'merged', 'failed']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export type ReviewQueueEntry = {
  id: string;
  agent_id: string;
  bead_id: string;
  rig_id: string;
  branch: string;
  pr_url: string | null;
  status: ReviewStatus;
  summary: string | null;
  created_at: string;
  processed_at: string | null;
};

export type ReviewQueueInput = {
  agent_id: string;
  bead_id: string;
  rig_id: string;
  branch: string;
  pr_url?: string;
  summary?: string;
  /** The rig's default branch. Used as target when not overridden by convoy feature branch. */
  default_branch?: string;
};

// -- Molecules (now beads with type='molecule' + child step beads) --

export const MoleculeStatus = z.enum(['active', 'completed', 'failed']);
export type MoleculeStatus = z.infer<typeof MoleculeStatus>;

export type Molecule = {
  id: string;
  bead_id: string;
  formula: unknown;
  current_step: number;
  status: MoleculeStatus;
  created_at: string;
  updated_at: string;
};

// -- Prime context --

export type PrimeContext = {
  agent: Agent;
  hooked_bead: Bead | null;
  undelivered_mail: Mail[];
  open_beads: Bead[];
  /** Present when the hooked bead is a rework request (gt:rework label). */
  rework_context: {
    feedback: string;
    branch: string | null;
    target_branch: string | null;
    files: string[];
    original_bead_title: string | null;
    mr_bead_id: string | null;
  } | null;
  /** Present when the hooked bead is a PR fixup (gt:pr-fixup label). */
  pr_fixup_context: {
    pr_url: string | null;
    branch: string | null;
    target_branch: string | null;
  } | null;
};

// -- Agent done --

export type AgentDoneInput = {
  branch: string;
  pr_url?: string;
  summary?: string;
};

// -- Patrol --

export type PatrolResult = {
  dead_agents: string[];
  stale_agents: string[];
  orphaned_beads: string[];
};

// -- Merge Strategy --

export const MergeStrategy = z.enum(['direct', 'pr']);
export type MergeStrategy = z.infer<typeof MergeStrategy>;

// -- Town Configuration --

export const TownConfigSchema = z.object({
  /** Environment variables injected into all agent processes */
  env_vars: z.record(z.string(), z.string()).default({}),

  /** Git authentication (used by git-manager for clone/push) */
  git_auth: z
    .object({
      github_token: z.string().optional(),
      gitlab_token: z.string().optional(),
      gitlab_instance_url: z.string().optional(),
      /** Platform integration ID used to refresh tokens (stored for token refresh) */
      platform_integration_id: z.string().optional(),
    })
    .default({}),

  /** Owner user ID — stored so the mayor can mint JWTs without a rig config */
  owner_user_id: z.string().optional(),

  /** Town ownership type */
  owner_type: z.enum(['user', 'org']).optional().default('user'),
  /** Owner identifier — userId when owner_type='user', orgId when owner_type='org' */
  owner_id: z.string().optional(),
  /** The userId who originally created this town (for audit trail in org towns) */
  created_by_user_id: z.string().optional(),
  /** Organization ID — set when owner_type='org', convenience alias for owner_id */
  organization_id: z.string().optional(),

  /** Kilo API token for LLM gateway authentication */
  kilocode_token: z.string().optional(),

  /** Default LLM model for new agent sessions */
  default_model: z.string().optional(),

  /** Per-role model overrides. When set, the specified role uses this model
   *  instead of default_model. */
  role_models: z
    .object({
      mayor: z.string().optional(),
      refinery: z.string().optional(),
      polecat: z.string().optional(),
    })
    .optional(),

  /** Lightweight model for title generation, explore subagent, etc. */
  small_model: z.string().optional(),

  /** Maximum concurrent polecats per rig */
  max_polecats_per_rig: z.number().int().min(1).max(50).optional(),

  /**
   * Town-level merge strategy. Rigs inherit this when they don't set their own.
   * - 'direct': Refinery pushes directly to main (no PR)
   * - 'pr': Refinery creates a GitHub PR / GitLab MR for human review
   */
  merge_strategy: MergeStrategy.default('direct'),

  /** Refinery configuration */
  refinery: z
    .object({
      gates: z.array(z.string()).default([]),
      auto_merge: z.boolean().default(true),
      require_clean_merge: z.boolean().default(true),
      /** When enabled, the refinery agent reviews PRs and adds GitHub review
       *  comments. Disable if you use an external code-review bot. */
      code_review: z.boolean().default(true),
      /** When enabled, a polecat is automatically dispatched to address
       *  unresolved review comments and failing CI checks on open PRs. */
      auto_resolve_pr_feedback: z.boolean().default(false),
      /** After all CI checks pass and all review threads are resolved,
       *  automatically merge the PR after this many minutes.
       *  0 = immediate, null = disabled (require manual merge). */
      auto_merge_delay_minutes: z.number().int().min(0).nullable().default(null),
    })
    .optional(),

  /** Alarm interval when agents are active (seconds) */
  alarm_interval_active: z.number().int().min(5).max(600).optional(),

  /** Alarm interval when idle (seconds) */
  alarm_interval_idle: z.number().int().min(30).max(3600).optional(),

  /** Container settings */
  container: z
    .object({
      sleep_after_minutes: z.number().int().min(5).max(120).optional(),
    })
    .optional(),

  /** When true, all convoys are created as staged by default (agents not dispatched until started). */
  staged_convoys_default: z.boolean().default(false),

  /** GitHub PAT used exclusively for `gh` CLI operations (PRs, issues, etc.).
   *  Git clone/push still uses the integration token from git_auth. */
  github_cli_pat: z.string().optional(),

  /** Custom git commit author name. When set, the user becomes the primary author
   *  and the AI agent is added as co-author (unless disable_ai_coauthor is true). */
  git_author_name: z.string().optional(),

  /** Custom git commit author email. Used alongside git_author_name. */
  git_author_email: z.string().optional(),

  /** When true, AI agent co-authorship trailer is omitted from commits.
   *  Only takes effect when git_author_name is set. */
  disable_ai_coauthor: z.boolean().default(false),
});

export type TownConfig = z.infer<typeof TownConfigSchema>;

/**
 * Partial update schema — all fields optional, NO defaults.
 * TownConfigSchema.partial() can't be used here because Zod still fires
 * .default() during parsing, injecting phantom values (e.g. merge_strategy:
 * 'direct') that overwrite existing config on partial updates.
 */
export const TownConfigUpdateSchema = z.object({
  env_vars: z.record(z.string(), z.string()).optional(),
  git_auth: z
    .object({
      github_token: z.string().optional(),
      gitlab_token: z.string().optional(),
      gitlab_instance_url: z.string().optional(),
      platform_integration_id: z.string().optional(),
    })
    .optional(),
  owner_user_id: z.string().optional(),
  owner_type: z.enum(['user', 'org']).optional(),
  owner_id: z.string().optional(),
  created_by_user_id: z.string().optional(),
  organization_id: z.string().optional(),
  kilocode_token: z.string().optional(),
  default_model: z.string().optional(),
  role_models: z
    .object({
      mayor: z.string().optional(),
      refinery: z.string().optional(),
      polecat: z.string().optional(),
    })
    .optional(),
  small_model: z.string().optional(),
  max_polecats_per_rig: z.number().int().min(1).max(50).optional(),
  merge_strategy: MergeStrategy.optional(),
  refinery: z
    .object({
      gates: z.array(z.string()).optional(),
      auto_merge: z.boolean().optional(),
      require_clean_merge: z.boolean().optional(),
      code_review: z.boolean().optional(),
      auto_resolve_pr_feedback: z.boolean().optional(),
      auto_merge_delay_minutes: z.number().int().min(0).nullable().optional(),
    })
    .optional(),
  alarm_interval_active: z.number().int().min(5).max(600).optional(),
  alarm_interval_idle: z.number().int().min(30).max(3600).optional(),
  container: z
    .object({
      sleep_after_minutes: z.number().int().min(5).max(120).optional(),
    })
    .optional(),
  staged_convoys_default: z.boolean().optional(),
  github_cli_pat: z.string().optional(),
  git_author_name: z.string().optional(),
  git_author_email: z.string().optional(),
  disable_ai_coauthor: z.boolean().optional(),
});
export type TownConfigUpdate = z.infer<typeof TownConfigUpdateSchema>;

/** Agent-level config overrides (merged on top of town config) */
export const AgentConfigOverridesSchema = z.object({
  env_vars: z.record(z.string(), z.string()).optional(),
  model: z.string().optional(),
});
export type AgentConfigOverrides = z.infer<typeof AgentConfigOverridesSchema>;

// -- UI Actions (mayor → dashboard WebSocket commands) --

export const UiActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open_bead_drawer'),
    beadId: z.string().min(1),
    rigId: z.string().min(1),
  }),
  z.object({
    type: z.literal('open_convoy_drawer'),
    convoyId: z.string().min(1),
    townId: z.string().min(1),
  }),
  z.object({
    type: z.literal('open_agent_drawer'),
    agentId: z.string().min(1),
    rigId: z.string().min(1),
    townId: z.string().min(1),
  }),
  z.object({
    type: z.literal('navigate'),
    page: z.enum(['town-overview', 'beads', 'agents', 'rigs', 'settings']),
  }),
  z.object({
    type: z.literal('highlight_bead'),
    beadId: z.string().min(1),
    rigId: z.string().min(1),
  }),
]);
export type UiAction = z.infer<typeof UiActionSchema>;

/**
 * Overwrite any `townId` field in the action with the route-scoped townId
 * so callers can't reference resources outside the authenticated town.
 */
export function normalizeUiAction(action: UiAction, townId: string): UiAction {
  if ('townId' in action) {
    return { ...action, townId };
  }
  return action;
}

/** Extract the rigId from a UI action, if present. */
export function uiActionRigId(action: UiAction): string | null {
  if ('rigId' in action) return action.rigId;
  return null;
}

// Re-export satellite metadata types for convenience
export type { AgentMetadataRecord } from './db/tables/agent-metadata.table';
export type { ReviewMetadataRecord } from './db/tables/review-metadata.table';
export type { EscalationMetadataRecord } from './db/tables/escalation-metadata.table';
export type { ConvoyMetadataRecord, ConvoyMergeMode } from './db/tables/convoy-metadata.table';
export type { BeadEventRecord } from './db/tables/bead-events.table';
export type { BeadDependencyRecord } from './db/tables/bead-dependencies.table';

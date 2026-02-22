import { z } from 'zod';
import type { BeadRecord } from './db/tables/beads.table';
import type { AgentMetadataRecord } from './db/tables/agent-metadata.table';
import type { ReviewMetadataRecord } from './db/tables/review-metadata.table';
import type { EscalationMetadataRecord } from './db/tables/escalation-metadata.table';
import type { ConvoyMetadataRecord } from './db/tables/convoy-metadata.table';
import type { BeadEventRecord } from './db/tables/bead-events.table';

// -- Beads --

export const BeadStatus = z.enum(['open', 'in_progress', 'closed', 'failed']);
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

export const AgentRole = z.enum(['polecat', 'refinery', 'mayor', 'witness']);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentStatus = z.enum(['idle', 'working', 'stalled', 'dead']);
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
  checkpoint: unknown;
  created_at: string;
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
  branch: string;
  pr_url?: string;
  summary?: string;
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
    })
    .default({}),

  /** Owner user ID — stored so the mayor can mint JWTs without a rig config */
  owner_user_id: z.string().optional(),

  /** Kilo API token for LLM gateway authentication */
  kilocode_token: z.string().optional(),

  /** Default LLM model for new agent sessions */
  default_model: z.string().optional(),

  /** Maximum concurrent polecats per rig */
  max_polecats_per_rig: z.number().int().min(1).max(20).optional(),

  /** Refinery configuration */
  refinery: z
    .object({
      gates: z.array(z.string()).default([]),
      auto_merge: z.boolean().default(true),
      require_clean_merge: z.boolean().default(true),
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
});

export type TownConfig = z.infer<typeof TownConfigSchema>;

/** Partial update schema — all fields optional for merge updates */
export const TownConfigUpdateSchema = TownConfigSchema.partial();
export type TownConfigUpdate = z.infer<typeof TownConfigUpdateSchema>;

/** Agent-level config overrides (merged on top of town config) */
export const AgentConfigOverridesSchema = z.object({
  env_vars: z.record(z.string(), z.string()).optional(),
  model: z.string().optional(),
});
export type AgentConfigOverrides = z.infer<typeof AgentConfigOverridesSchema>;

// Re-export satellite metadata types for convenience
export type { AgentMetadataRecord } from './db/tables/agent-metadata.table';
export type { ReviewMetadataRecord } from './db/tables/review-metadata.table';
export type { EscalationMetadataRecord } from './db/tables/escalation-metadata.table';
export type { ConvoyMetadataRecord } from './db/tables/convoy-metadata.table';
export type { BeadEventRecord } from './db/tables/bead-events.table';
export type { BeadDependencyRecord } from './db/tables/bead-dependencies.table';

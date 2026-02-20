import { z } from 'zod';
import type { RigBeadRecord } from './db/tables/rig-beads.table';
import type { RigAgentRecord } from './db/tables/rig-agents.table';
import type { RigMailRecord } from './db/tables/rig-mail.table';
import type { RigReviewQueueRecord } from './db/tables/rig-review-queue.table';
import type { RigMoleculeRecord } from './db/tables/rig-molecules.table';

// -- Beads --

export const BeadStatus = z.enum(['open', 'in_progress', 'closed', 'failed']);
export type BeadStatus = z.infer<typeof BeadStatus>;

export const BeadType = z.enum(['issue', 'message', 'escalation', 'merge_request']);
export type BeadType = z.infer<typeof BeadType>;

export const BeadPriority = z.enum(['low', 'medium', 'high', 'critical']);
export type BeadPriority = z.infer<typeof BeadPriority>;

export type Bead = RigBeadRecord;

export type CreateBeadInput = {
  type: BeadType;
  title: string;
  body?: string;
  priority?: BeadPriority;
  labels?: string[];
  metadata?: Record<string, unknown>;
  assignee_agent_id?: string;
  convoy_id?: string;
};

export type BeadFilter = {
  status?: BeadStatus;
  type?: BeadType;
  assignee_agent_id?: string;
  convoy_id?: string;
  limit?: number;
  offset?: number;
};

// -- Agents --

export const AgentRole = z.enum(['polecat', 'refinery', 'mayor', 'witness']);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentStatus = z.enum(['idle', 'working', 'blocked', 'dead']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export type Agent = RigAgentRecord;

export type RegisterAgentInput = {
  role: AgentRole;
  name: string;
  identity: string;
};

export type AgentFilter = {
  role?: AgentRole;
  status?: AgentStatus;
};

// -- Mail --

export type Mail = RigMailRecord;

export type SendMailInput = {
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  body: string;
};

// -- Review Queue --

export const ReviewStatus = z.enum(['pending', 'running', 'merged', 'failed']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export type ReviewQueueEntry = RigReviewQueueRecord;

export type ReviewQueueInput = {
  agent_id: string;
  bead_id: string;
  branch: string;
  pr_url?: string;
  summary?: string;
};

// -- Molecules --

export const MoleculeStatus = z.enum(['active', 'completed', 'failed']);
export type MoleculeStatus = z.infer<typeof MoleculeStatus>;

export type Molecule = RigMoleculeRecord;

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

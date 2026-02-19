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

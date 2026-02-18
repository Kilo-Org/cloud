import { z } from 'zod';
import type { BeadRecord } from './db/tables/beads.table';
import type { AgentRecord } from './db/tables/agents.table';
import type { MailRecord } from './db/tables/mail.table';
import type { ReviewQueueRecord } from './db/tables/review-queue.table';
import type { MoleculeRecord } from './db/tables/molecules.table';

// -- Beads --

export const BeadStatus = z.enum(['open', 'in_progress', 'closed', 'failed']);
export type BeadStatus = z.infer<typeof BeadStatus>;

export const BeadType = z.enum(['issue', 'message', 'escalation', 'merge_request']);
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

export type Agent = AgentRecord;

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

export type Mail = MailRecord;

export type SendMailInput = {
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  body: string;
};

// -- Review Queue --

export const ReviewStatus = z.enum(['pending', 'running', 'merged', 'failed']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export type ReviewQueueEntry = ReviewQueueRecord;

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

export type Molecule = MoleculeRecord;

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

// Types mirroring the Town DO domain model.
// These are the API response shapes — the plugin never touches SQLite directly.

export type BeadStatus = 'open' | 'in_progress' | 'in_review' | 'closed' | 'failed';
export type BeadType =
  | 'issue'
  | 'message'
  | 'escalation'
  | 'merge_request'
  | 'convoy'
  | 'molecule'
  | 'agent';
export type BeadPriority = 'low' | 'medium' | 'high' | 'critical';

export type Bead = {
  bead_id: string;
  type: BeadType;
  status: BeadStatus;
  title: string;
  body: string | null;
  rig_id: string | null;
  parent_bead_id: string | null;
  assignee_agent_bead_id: string | null;
  priority: BeadPriority;
  labels: string[];
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type AgentRole = 'polecat' | 'refinery' | 'mayor';
export type AgentStatus = 'idle' | 'working' | 'stalled' | 'dead';

export type Agent = {
  id: string;
  rig_id: string | null;
  role: AgentRole;
  name: string;
  identity: string;
  status: AgentStatus;
  current_hook_bead_id: string | null;
  dispatch_attempts: number;
  last_activity_at: string | null;
  checkpoint: unknown | null;
  created_at: string;
};

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

export type PrimeContext = {
  agent: Agent;
  hooked_bead: Bead | null;
  undelivered_mail: Mail[];
  open_beads: Bead[];
};

// API response envelope
export type ApiSuccess<T> = { success: true; data: T };
export type ApiError = { success: false; error: string };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// Rig metadata (from GastownUserDO)
export type Rig = {
  id: string;
  town_id: string;
  name: string;
  git_url: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
};

// Sling result (bead + assigned agent)
export type SlingResult = {
  bead: Bead;
  agent: Agent;
};

// Sling batch result (convoy + beads + agents)
// agent is null for staged convoys (agents aren't assigned until gt_convoy_start)
export type SlingBatchResult = {
  convoy: Convoy;
  beads: Array<{ bead: Bead; agent: Agent | null }>;
};

// Convoy summary (returned by list and status endpoints)
// Staging is tracked by the `staged` boolean, not the status field.
// status tracks the convoy lifecycle: active (in progress) or landed (complete).
export type Convoy = {
  id: string;
  title: string;
  status: 'active' | 'landed';
  staged: boolean;
  total_beads: number;
  closed_beads: number;
  created_by: string | null;
  created_at: string;
  landed_at: string | null;
};

// Result returned by POST /convoys/:id/start
export type ConvoyStartResult = {
  convoy: Convoy;
  beads: Array<{ bead: Bead; agent: Agent }>;
};

// Detailed convoy status with per-bead breakdown
export type ConvoyDetail = Convoy & {
  beads: Array<{
    bead_id: string;
    title: string;
    status: BeadStatus;
    rig_id: string | null;
    assignee_agent_name: string | null;
  }>;
};

// Environment variable config for the plugin (rig-scoped agents)
export type GastownEnv = {
  apiUrl: string;
  /** Container-scoped JWT (shared by all agents, refreshed by alarm). */
  containerToken?: string;
  /** Legacy per-agent JWT (8h expiry) — fallback during rollout. */
  sessionToken: string;
  agentId: string;
  rigId: string;
  townId: string;
};

// Environment variable config for the mayor (town-scoped)
export type MayorGastownEnv = {
  apiUrl: string;
  /** Container-scoped JWT (shared by all agents, refreshed by alarm). */
  containerToken?: string;
  /** Legacy per-agent JWT (8h expiry) — fallback during rollout. */
  sessionToken: string;
  agentId: string;
  townId: string;
};

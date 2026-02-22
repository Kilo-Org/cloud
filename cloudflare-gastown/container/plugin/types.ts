// Types mirroring the Town DO domain model.
// These are the API response shapes — the plugin never touches SQLite directly.

export type BeadStatus = 'open' | 'in_progress' | 'closed' | 'failed';
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

export type AgentRole = 'polecat' | 'refinery' | 'mayor' | 'witness';
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

// Environment variable config for the plugin (rig-scoped agents)
export type GastownEnv = {
  apiUrl: string;
  sessionToken: string;
  agentId: string;
  rigId: string;
  townId: string;
};

// Environment variable config for the mayor (town-scoped)
export type MayorGastownEnv = {
  apiUrl: string;
  sessionToken: string;
  agentId: string;
  townId: string;
};

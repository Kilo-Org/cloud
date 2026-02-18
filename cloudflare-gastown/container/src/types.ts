import { z } from 'zod';

// ── Agent roles (mirrors worker types) ──────────────────────────────────

export const AgentRole = z.enum(['mayor', 'polecat', 'refinery', 'witness']);
export type AgentRole = z.infer<typeof AgentRole>;

// ── Control server request/response schemas ─────────────────────────────

export const StartAgentRequest = z.object({
  agentId: z.string(),
  rigId: z.string(),
  townId: z.string(),
  role: AgentRole,
  name: z.string(),
  identity: z.string(),
  prompt: z.string(),
  model: z.string(),
  systemPrompt: z.string(),
  gitUrl: z.string(),
  branch: z.string(),
  defaultBranch: z.string(),
  envVars: z.record(z.string(), z.string()).optional(),
});
export type StartAgentRequest = z.infer<typeof StartAgentRequest>;

export const StopAgentRequest = z.object({
  signal: z.enum(['SIGTERM', 'SIGKILL']).optional(),
});
export type StopAgentRequest = z.infer<typeof StopAgentRequest>;

export const SendMessageRequest = z.object({
  prompt: z.string(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

// ── Agent lifecycle ─────────────────────────────────────────────────────

export const AgentStatus = z.enum(['starting', 'running', 'stopping', 'exited', 'failed']);
export type AgentStatus = z.infer<typeof AgentStatus>;

// Kept for backward compat — external callers (DO, heartbeat) still reference this name.
export const ProcessStatus = AgentStatus;
export type ProcessStatus = AgentStatus;

/**
 * Tracks a managed agent: a kilo serve session backed by an SSE subscription.
 * Replaces the old AgentProcess (raw child process + stdin pipe).
 */
export type ManagedAgent = {
  agentId: string;
  rigId: string;
  townId: string;
  role: AgentRole;
  name: string;
  status: AgentStatus;
  /** Port of the kilo serve instance this agent's session lives on */
  serverPort: number;
  /** Session ID within the kilo serve instance */
  sessionId: string;
  /** Working directory (git worktree) */
  workdir: string;
  startedAt: string;
  lastActivityAt: string;
  /** Last known active tool calls (populated from SSE events) */
  activeTools: string[];
  /** Total messages sent to this agent */
  messageCount: number;
  /** Exit reason if status is 'exited' or 'failed' */
  exitReason: string | null;
};

export type AgentStatusResponse = {
  agentId: string;
  status: AgentStatus;
  serverPort: number;
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  activeTools: string[];
  messageCount: number;
  exitReason: string | null;
};

export type HealthResponse = {
  status: 'ok' | 'degraded';
  agents: number;
  servers: number;
  uptime: number;
};

// ── Kilo serve instance ─────────────────────────────────────────────────

export type KiloServerInstance = {
  /** Port the kilo serve process is listening on */
  port: number;
  /** Working directory (project root) the server was started in */
  workdir: string;
  /** The Bun subprocess handle */
  process: import('bun').Subprocess;
  /** Agent IDs with sessions on this server */
  sessionIds: Set<string>;
  /** Tracks whether the server is healthy (responded to /global/health) */
  healthy: boolean;
};

/**
 * Session info returned by kilo serve POST /session.
 */
export type KiloSession = {
  id: string;
  title?: string;
};

// ── SSE events ──────────────────────────────────────────────────────────

export type KiloSSEEvent = {
  event: string;
  data: unknown;
};

// ── Git manager ─────────────────────────────────────────────────────────

export type CloneOptions = {
  rigId: string;
  gitUrl: string;
  defaultBranch: string;
};

export type WorktreeOptions = {
  rigId: string;
  branch: string;
};

// ── Heartbeat ───────────────────────────────────────────────────────────

export type HeartbeatPayload = {
  agentId: string;
  rigId: string;
  townId: string;
  status: AgentStatus;
  timestamp: string;
};

// ── Stream ticket (for WebSocket streaming) ─────────────────────────────

export type StreamTicketResponse = {
  ticket: string;
  expiresAt: string;
};

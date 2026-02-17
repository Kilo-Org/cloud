import { z } from 'zod';

// ── Agent roles (mirrors worker types) ──────────────────────────────────

export const AgentRole = z.enum(['mayor', 'polecat', 'refinery']);
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

// ── Process lifecycle ───────────────────────────────────────────────────

export const ProcessStatus = z.enum(['starting', 'running', 'stopping', 'exited', 'failed']);
export type ProcessStatus = z.infer<typeof ProcessStatus>;

export type AgentProcess = {
  agentId: string;
  rigId: string;
  townId: string;
  role: AgentRole;
  name: string;
  pid: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  workdir: string;
  startedAt: string;
  lastActivityAt: string;
};

export type AgentStatusResponse = {
  agentId: string;
  status: ProcessStatus;
  pid: number | null;
  exitCode: number | null;
  startedAt: string;
  lastActivityAt: string;
};

export type HealthResponse = {
  status: 'ok' | 'degraded';
  agents: number;
  uptime: number;
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
  status: ProcessStatus;
  timestamp: string;
};

// ── Stream ticket (for WebSocket streaming) ─────────────────────────────

export type StreamTicketResponse = {
  ticket: string;
  expiresAt: string;
};

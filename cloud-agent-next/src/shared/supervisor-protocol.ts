/**
 * Shared types for the supervisor init protocol.
 * Used by both the DO-side (wrapper-client.ts, orchestrator.ts)
 * and the wrapper-side (supervisor.ts).
 */

export type SupervisorInitPayload = {
  agentSessionId: string;
  userId: string;
  workspacePath: string;
  sessionHome: string;
  ingest: {
    url: string;
    token: string;
    workerAuthToken: string;
  };
  repo: {
    url: string;
    branch?: string;
    ref?: string;
  };
  setupCommands?: string[];
  auth?: {
    kilocodeToken: string;
  };
  sessionImport?: {
    kiloSessionId: string;
    snapshotUrl?: string;
  };
  env?: Record<string, string>;
};

export type SupervisorInitResponse = {
  status: 'ready' | 'error';
  kiloSessionId?: string;
  step?: string;
  message?: string;
};

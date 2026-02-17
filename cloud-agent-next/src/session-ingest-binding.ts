/**
 * RPC method types for the SESSION_INGEST service binding.
 *
 * `wrangler types` only sees `Fetcher` for service bindings; the actual RPC
 * shape comes from the session-ingest worker's WorkerEntrypoint and is
 * declared here so the generated file can be freely regenerated.
 *
 * Keep in sync with: cloudflare-session-ingest/src/session-ingest-rpc.ts
 */

export type CreateSessionForCloudAgentParams = {
  sessionId: string;
  kiloUserId: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  createdOnPlatform: string;
};

export type DeleteSessionForCloudAgentParams = {
  sessionId: string;
  kiloUserId: string;
};

export type SessionIngestBinding = Fetcher & {
  createSessionForCloudAgent(params: CreateSessionForCloudAgentParams): Promise<void>;
  deleteSessionForCloudAgent(params: DeleteSessionForCloudAgentParams): Promise<void>;
};

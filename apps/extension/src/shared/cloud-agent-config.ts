/**
 * Extension build/serve URL configuration for Cloud Agent and session-ingest
 * WebSocket endpoints. Matches the precedence conventions established by
 * {@link getKiloApiBaseUrl} in `auth.ts`:
 *
 * 1. Vite env override (`VITE_CLOUD_AGENT_WS_URL` / `VITE_SESSION_INGEST_WS_URL`)
 * 2. Local serve fallback
 * 3. Production fallback
 */
const DEFAULT_CLOUD_AGENT_WS_URL = 'wss://cloud-agent-next.kilosessions.ai';
const DEFAULT_SESSION_INGEST_WS_URL = 'wss://ingest.kilosessions.ai';
const DEFAULT_LOCAL_CLOUD_AGENT_WS_URL = 'ws://localhost:8794';
const DEFAULT_LOCAL_SESSION_INGEST_WS_URL = 'ws://localhost:8800';

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export const getCloudAgentWsUrl = (): string => {
  const configuredUrl = import.meta.env.VITE_CLOUD_AGENT_WS_URL;

  if (typeof configuredUrl === 'string' && configuredUrl.trim().length > 0) {
    return trimTrailingSlash(configuredUrl.trim());
  }

  if (import.meta.env.COMMAND === 'serve') {
    return DEFAULT_LOCAL_CLOUD_AGENT_WS_URL;
  }

  return DEFAULT_CLOUD_AGENT_WS_URL;
};

export const getSessionIngestWsUrl = (): string => {
  const configuredUrl = import.meta.env.VITE_SESSION_INGEST_WS_URL;

  if (typeof configuredUrl === 'string' && configuredUrl.trim().length > 0) {
    return trimTrailingSlash(configuredUrl.trim());
  }

  if (import.meta.env.COMMAND === 'serve') {
    return DEFAULT_LOCAL_SESSION_INGEST_WS_URL;
  }

  return DEFAULT_SESSION_INGEST_WS_URL;
};

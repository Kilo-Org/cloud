import type {
  RemoteMcpAuth,
  RemoteMcpCachedTool,
  RemoteMcpServer,
  RemoteMcpStatus,
  RemoteMcpStore,
} from '../../src/shared/remote-mcp';
import type { RemoteMcpServerDraft } from '../../src/shared/remote-mcp-storage';
import { upsertRemoteMcpServer } from '../../src/shared/remote-mcp-storage';

export const getConnectButtonLabel = (status: RemoteMcpStatus): 'Connect' | 'Refresh' =>
  status === 'untested' || status === 'needs_auth' ? 'Connect' : 'Refresh';

const buildAuth = (
  fields: {
    authType: 'none' | 'bearer' | 'header' | 'oauth';
    bearerToken: string;
    headerName: string;
    headerValue: string;
  },
  existingAuth?: RemoteMcpAuth
): RemoteMcpAuth => {
  switch (fields.authType) {
    case 'bearer': {
      if (fields.bearerToken.length > 0) {
        return { token: fields.bearerToken, type: 'bearer' };
      }
      if (existingAuth?.type === 'bearer' && existingAuth.token !== undefined) {
        return { token: existingAuth.token, type: 'bearer' };
      }
      return { type: 'bearer' };
    }
    case 'header': {
      if (fields.headerValue.length > 0) {
        return { headerName: fields.headerName, headerValue: fields.headerValue, type: 'header' };
      }
      if (existingAuth?.type === 'header' && existingAuth.headerValue !== undefined) {
        return {
          headerName: fields.headerName,
          headerValue: existingAuth.headerValue,
          type: 'header',
        };
      }
      return { headerName: fields.headerName, type: 'header' };
    }
    case 'oauth': {
      return { type: 'oauth' };
    }
    case 'none': {
      return { type: 'none' };
    }
  }
};

export const buildDraftFromForm = (
  fields: {
    displayName: string;
    url: string;
    authType: 'none' | 'bearer' | 'header' | 'oauth';
    bearerToken: string;
    headerName: string;
    headerValue: string;
    enabled: boolean;
    allowInSafeMode: boolean;
    id?: string;
  },
  existingAuth?: RemoteMcpAuth
): RemoteMcpServerDraft => ({
  allowInSafeMode: fields.allowInSafeMode,
  auth: buildAuth(fields, existingAuth),
  displayName: fields.displayName,
  enabled: fields.enabled,
  url: fields.url,
  ...(fields.id === undefined ? {} : { id: fields.id }),
});

export const applyUpsert = (
  store: RemoteMcpStore,
  draft: RemoteMcpServerDraft
): { store: RemoteMcpStore; error: string | null } => {
  try {
    const nextStore = upsertRemoteMcpServer(store, draft);
    return { error: null, store: nextStore };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    return { error: message, store };
  }
};

export const removeServer = (store: RemoteMcpStore, serverId: string): RemoteMcpStore => ({
  servers: store.servers.filter(server => server.id !== serverId),
});

export const formatToolCount = (count: number): string =>
  count === 1 ? '1 tool' : `${count} tools`;

export const formatLastConnected = (isoString?: string): string => {
  if (isoString === undefined) {
    return 'Never';
  }

  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) {
    return 'just now';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffMinutes < 60) {
    return `${diffMinutes} ${diffMinutes === 1 ? 'minute' : 'minutes'} ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
};

export const toolsToJsonString = (tools: readonly RemoteMcpCachedTool[]): string =>
  JSON.stringify(tools, null, 2);

export const isSecretSaved = (server?: RemoteMcpServer): boolean => {
  if (server === undefined) {
    return false;
  }

  if (server.auth.type === 'bearer') {
    return server.auth.token !== undefined;
  }

  if (server.auth.type === 'header') {
    return server.auth.headerValue !== undefined;
  }

  return false;
};

export type RemoteMcpStatus = 'connected' | 'needs_auth' | 'unavailable' | 'untested';

export interface RemoteMcpOAuthState {
  readonly authorizationUrl?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly tokenType?: string | undefined;
}

export type RemoteMcpAuth =
  | { readonly type: 'none' }
  | { readonly token?: string; readonly type: 'bearer' }
  | { readonly headerName: string; readonly headerValue?: string; readonly type: 'header' }
  | { readonly type: 'oauth'; readonly oauth?: RemoteMcpOAuthState | undefined };

export interface RemoteMcpCachedTool {
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly name: string;
}

export interface RemoteMcpServer {
  readonly allowInSafeMode: boolean;
  readonly auth: RemoteMcpAuth;
  readonly cachedTools: readonly RemoteMcpCachedTool[];
  readonly displayName: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly lastConnectedAt?: string | undefined;
  readonly lastError?: string | undefined;
  readonly slug: string;
  readonly status: RemoteMcpStatus;
  readonly url: string;
}

export interface RemoteMcpStore {
  readonly servers: readonly RemoteMcpServer[];
}

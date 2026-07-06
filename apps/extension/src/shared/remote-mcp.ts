import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export type RemoteMcpStatus = 'connected' | 'needs_auth' | 'unavailable' | 'untested';

export interface RemoteMcpOAuthState {
  /** Dynamic client registration returned by the authorization server. */
  readonly clientInformation?: OAuthClientInformationMixed | undefined;
  /** Access/refresh tokens issued for this server. */
  readonly tokens?: OAuthTokens | undefined;
  /** PKCE code verifier kept between redirect and token exchange. */
  readonly codeVerifier?: string | undefined;
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

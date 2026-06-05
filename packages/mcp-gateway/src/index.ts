export {
  GatewayOwnerScope,
  GatewayRouteScope,
  GatewayAuthMode,
  GatewaySharingMode,
  GatewayInstanceStatus,
  GatewayRouteStatus,
  GatewayProviderGrantStatus,
  GatewayOAuthClientAuthMethod,
  GatewayAuthorizationRequestStatus,
  GatewayPendingProviderAuthorizationStatus,
  GatewaySecretKind,
  GatewaySupportedScopes,
  GatewayAuditOutcome,
  GatewayExecutionContextSchema,
} from './types';
export type { GatewaySupportedScope, GatewayExecutionContext } from './types';

export { GatewayErrorCode, GatewayError, createGatewayError } from './errors';

export {
  UserConnectRouteParamsSchema,
  OrgConnectRouteParamsSchema,
  ownerScopeFromRouteScope,
  buildScopedConnectRootPath,
  buildScopedConnectCanonicalUrl,
  buildMCPID,
  parseScopedConnectPath,
} from './routes';
export type { UserConnectRouteParams, OrgConnectRouteParams, ScopedConnectRoute } from './routes';

export {
  GatewayScopeSchema,
  GatewayScopeListSchema,
  GatewayTokenClaimsSchema,
  GatewayTokenMintInputSchema,
  OAuthClientMetadataSchema,
  OAuthAuthorizationQuerySchema,
  OAuthTokenRequestSchema,
  ProviderAuthorizationServerMetadataSchema,
  RemoteProtectedResourceMetadataSchema,
  ProviderTokenResponseSchema,
  ProviderGrantBundleSchema,
  ConfigSecretBundleSchema,
  GatewayConfigInputSchema,
  parseScopeString,
  filterSupportedScopes,
} from './schemas';
export type {
  GatewayTokenClaims,
  GatewayTokenMintInput,
  OAuthClientMetadata,
  OAuthAuthorizationQuery,
  OAuthTokenRequest,
  ProviderAuthorizationServerMetadata,
  RemoteProtectedResourceMetadata,
  ProviderTokenResponse,
  ProviderGrantBundle,
} from './schemas';

export {
  isAllowedTransientHeader,
  isCredentialLikeHeader,
  buildUpstreamHeaders,
  parseStaticHeaders,
  parseAuxiliaryHeaders,
} from './headers';
export { isIpAddress, isPublicIp } from './ip';

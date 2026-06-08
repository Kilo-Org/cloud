import { z } from 'zod';

export const GatewayOwnerScope = {
  Personal: 'personal',
  Organization: 'organization',
} as const;

export type GatewayOwnerScope = (typeof GatewayOwnerScope)[keyof typeof GatewayOwnerScope];

export const GatewayRouteScope = {
  User: 'user',
  Org: 'org',
} as const;

export type GatewayRouteScope = (typeof GatewayRouteScope)[keyof typeof GatewayRouteScope];

export const GatewayAuthMode = {
  None: 'none',
  StaticHeaders: 'static_headers',
  OAuthDynamic: 'oauth_dynamic',
  OAuthStatic: 'oauth_static',
} as const;

export type GatewayAuthMode = (typeof GatewayAuthMode)[keyof typeof GatewayAuthMode];

export const GatewaySharingMode = {
  SingleUser: 'single_user',
  MultiUser: 'multi_user',
} as const;

export type GatewaySharingMode = (typeof GatewaySharingMode)[keyof typeof GatewaySharingMode];

export const GatewayInstanceStatus = {
  Active: 'active',
  NeedsReauth: 'needs_reauth',
  Revoked: 'revoked',
  Removed: 'removed',
} as const;

export type GatewayInstanceStatus =
  (typeof GatewayInstanceStatus)[keyof typeof GatewayInstanceStatus];

export const GatewayRouteStatus = {
  Active: 'active',
  Rotated: 'rotated',
  Revoked: 'revoked',
} as const;

export type GatewayRouteStatus = (typeof GatewayRouteStatus)[keyof typeof GatewayRouteStatus];

export const GatewayProviderGrantStatus = {
  Active: 'active',
  Revoked: 'revoked',
} as const;

export type GatewayProviderGrantStatus =
  (typeof GatewayProviderGrantStatus)[keyof typeof GatewayProviderGrantStatus];

export const GatewayOAuthClientAuthMethod = {
  None: 'none',
  ClientSecretPost: 'client_secret_post',
  ClientSecretBasic: 'client_secret_basic',
} as const;

export type GatewayOAuthClientAuthMethod =
  (typeof GatewayOAuthClientAuthMethod)[keyof typeof GatewayOAuthClientAuthMethod];

export const GatewayAuthorizationRequestStatus = {
  Pending: 'pending',
  Completed: 'completed',
  Error: 'error',
} as const;

export type GatewayAuthorizationRequestStatus =
  (typeof GatewayAuthorizationRequestStatus)[keyof typeof GatewayAuthorizationRequestStatus];

export const GatewayPendingProviderAuthorizationStatus = {
  Pending: 'pending',
  Completed: 'completed',
  Error: 'error',
} as const;

export type GatewayPendingProviderAuthorizationStatus =
  (typeof GatewayPendingProviderAuthorizationStatus)[keyof typeof GatewayPendingProviderAuthorizationStatus];

export const GatewaySecretKind = {
  StaticProviderCredentials: 'static_provider_credentials',
  DynamicRegistration: 'dynamic_registration',
  StaticHeaders: 'static_headers',
} as const;

export type GatewaySecretKind = (typeof GatewaySecretKind)[keyof typeof GatewaySecretKind];

export const GatewaySupportedScopes = ['profile'] as const;
export type GatewaySupportedScope = (typeof GatewaySupportedScopes)[number];

export const GatewayExecutionContextSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('personal') }),
  z.object({ type: z.literal('organization'), organizationId: z.string().uuid() }),
]);

export type GatewayExecutionContext = z.infer<typeof GatewayExecutionContextSchema>;

export const GatewayAuditOutcome = {
  Success: 'success',
  Failure: 'failure',
  Blocked: 'blocked',
} as const;

export type GatewayAuditOutcome = (typeof GatewayAuditOutcome)[keyof typeof GatewayAuditOutcome];

import { decodeJwt } from 'jose';
import { z } from 'zod';
import { RUNTIME_CREDENTIAL_PROXY_AUDIENCE } from './internal-service-token-audiences';

export const CLOUD_AGENT_SESSION_SYNC_ORIGIN = 'https://session-sync.kiloapps.io';

export const cloudAgentSyncHostSchema = z.strictObject({
  cloudAgentSessionId: z
    .string()
    .regex(/^workspace_[A-Za-z0-9_-]+$/)
    .max(256),
});
const nativeSessionID = z
  .string()
  .regex(/^ses_[A-Za-z0-9_-]+$/)
  .max(256);
export const cloudAgentSyncNativeIdentitySchema = z
  .strictObject({
    sessionID: nativeSessionID,
    rootSessionID: nativeSessionID,
    kind: z.enum(['root', 'descendant']),
  })
  .refine(
    identity => (identity.sessionID === identity.rootSessionID) === (identity.kind === 'root')
  );
export const cloudAgentSyncLiveIdentitySchema = z.strictObject({
  allocationId: z.string().min(1).max(256),
  providerInstanceId: z.string().min(1).max(256),
});
export const cloudAgentSyncHostedClaims = {
  workload: z.literal('cloud-agent'),
  host: cloudAgentSyncHostSchema,
  native: cloudAgentSyncNativeIdentitySchema,
  liveIdentity: cloudAgentSyncLiveIdentitySchema,
};

export const cloudAgentSyncAuthorizationSchema = z.strictObject({
  userID: z.string().min(1).max(256),
  organizationID: z.uuid().optional(),
  expiresAt: z.number().int().positive(),
  host: cloudAgentSyncHostSchema.optional(),
});

export const cloudAgentSyncLiveRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('handle'),
    handle: z.string().min(1).max(4096),
    sessionID: nativeSessionID.optional(),
  }),
  z.strictObject({
    type: z.literal('ticket'),
    userID: z.string().min(1).max(256),
    organizationID: z.uuid().optional(),
    ...cloudAgentSyncHostedClaims,
  }),
]);
export const cloudAgentSyncLiveAuthorizationSchema = z.strictObject({
  userID: z.string().min(1).max(256),
  organizationID: z.uuid().optional(),
  expiresAt: z.number().int().positive(),
  ...cloudAgentSyncHostedClaims,
});
export const cloudAgentSyncLiveResultSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('allowed'),
    authorization: cloudAgentSyncLiveAuthorizationSchema,
  }),
  z.strictObject({
    type: z.literal('denied'),
    code: z.enum(['invalid_credential', 'access_denied', 'hosted_live_not_enabled']),
  }),
  z.strictObject({ type: z.literal('unavailable'), code: z.literal('auth_unavailable') }),
]);
export type CloudAgentSyncLiveRequest = z.infer<typeof cloudAgentSyncLiveRequestSchema>;
export type CloudAgentSyncLiveResult = z.infer<typeof cloudAgentSyncLiveResultSchema>;
export type CloudAgentSyncLiveAuthorization = z.infer<typeof cloudAgentSyncLiveAuthorizationSchema>;
export type CloudAgentSyncAuthorization = z.infer<typeof cloudAgentSyncAuthorizationSchema>;
export type CloudAgentSyncAuthorizationBinding = {
  authorizeUpload(input: {
    handle: string;
    sessionID?: string;
  }): Promise<CloudAgentSyncAuthorization | null>;
  authorizeLive(input: CloudAgentSyncLiveRequest): Promise<CloudAgentSyncLiveResult>;
};

/** Classification only. The Cloud Agent binding verifies the signature and current runtime fence. */
export function isCloudAgentSyncHandle(token: string): boolean {
  if (token.length > 4096) return false;
  try {
    return decodeJwt(token).aud === RUNTIME_CREDENTIAL_PROXY_AUDIENCE;
  } catch {
    return false;
  }
}

/** Allows uploads, status writes and receipt inspection; excludes transcript reads, deletion and control. */
export function cloudAgentSyncUploadSession(method: string, pathname: string): string | null {
  const match =
    /^\/v1\/sessions\/(ses_[A-Za-z0-9_-]{1,252})(\/batches|\/status|\/blobs\/[a-f0-9]{64})?$/.exec(
      pathname
    );
  if (!match) return null;
  const suffix = match[2];
  if (suffix === undefined) return method === 'GET' || method === 'PUT' ? match[1] : null;
  if (suffix === '/batches') return method === 'POST' ? match[1] : null;
  return method === 'PUT' ? match[1] : null;
}

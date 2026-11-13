import { decodeJwt } from 'jose';
import { z } from 'zod';
import { RUNTIME_CREDENTIAL_PROXY_AUDIENCE } from './internal-service-token-audiences';

export const CLOUD_AGENT_SESSION_SYNC_ORIGIN = 'https://session-sync.kiloapps.io';

export const cloudAgentSyncAuthorizationSchema = z.strictObject({
  userID: z.string().min(1).max(256),
  organizationID: z.uuid().optional(),
  expiresAt: z.number().int().positive(),
});

export type CloudAgentSyncAuthorization = z.infer<typeof cloudAgentSyncAuthorizationSchema>;
export type CloudAgentSyncAuthorizationBinding = {
  authorizeUpload(input: {
    handle: string;
    sessionID?: string;
  }): Promise<CloudAgentSyncAuthorization | null>;
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

/** Receipt inspection is required by the uploader; transcript reads, deletion and control are excluded. */
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

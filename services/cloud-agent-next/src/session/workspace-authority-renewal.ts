import jwt from 'jsonwebtoken';
import {
  createRuntimeAuthorization,
  sealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import { resolveRuntimeEnvironment } from '@kilocode/worker-utils/runtime-authorization-contract';
import { resolveSecret } from '../auth.js';
import { getWorkspaceStub } from '../control-plane/workspace/workspace-stub.js';
import { logger } from '../logger.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';
import { logRuntimeAuthorizationDiagnostic } from './runtime-authorization-diagnostics.js';
import { runtimeAuthorizationLifetime } from './runtime-authorization-lifetime.js';

/**
 * Whether a send carries the owner's own user credential. Delegated runtime
 * tokens, Cloud Agent authority and automation admissions never renew a
 * workspace authority.
 */
function isUserAdmission(token: string): boolean {
  const claims = jwt.decode(token);
  if (claims === null || typeof claims !== 'object') return false;
  const admission: unknown = claims.runtimeAdmission;
  return (
    !('cloudAgentAuthority' in claims) &&
    !('runtimeAuthorization' in claims) &&
    typeof admission === 'object' &&
    admission !== null &&
    'source' in admission &&
    admission.source === 'user'
  );
}

/**
 * A user send in any chat of a workspace is the owner re-authorizing that
 * workspace. When its Cloud Agent authority has expired, mint a new
 * delegation from the user's credential, with live owner, organization and
 * device-session checks, and hand it to the workspace. A revoked, deleted or
 * still active authority is left unchanged. MCP is optional, so a failure here
 * never fails the user's send.
 */
export async function renewWorkspaceAuthorityForUserSend(input: {
  env: Env;
  userId: string;
  authToken: string | undefined;
  workspaceSessionId: string | undefined;
}): Promise<void> {
  const { env, userId, authToken, workspaceSessionId } = input;
  if (authToken === undefined || workspaceSessionId === undefined) return;
  if (!isUserAdmission(authToken)) return;
  const stub = () => getWorkspaceStub(env, userId, workspaceSessionId);
  try {
    const status = await withDORetry(stub, workspace => workspace.describe(), 'describe');
    if (status.state !== 'expired' || status.authorizationId === null) return;
    const expectedAuthorizationId = status.authorizationId;
    const secret = await resolveSecret(env.NEXTAUTH_SECRET);
    if (!secret) return;
    const created = await createRuntimeAuthorization({
      token: authToken,
      secret,
      connectionString: env.HYPERDRIVE.connectionString,
      resourceKind: 'cloud-agent-next',
      resourceId: workspaceSessionId,
      environment: resolveRuntimeEnvironment(env.ENVIRONMENT),
      ...runtimeAuthorizationLifetime(env),
      ...(status.organizationId === null ? {} : { organizationId: status.organizationId }),
      onAdmissionRejected: reason =>
        logRuntimeAuthorizationDiagnostic(workspaceSessionId, 'admission', reason),
      onBindingRejected: reason =>
        logRuntimeAuthorizationDiagnostic(workspaceSessionId, 'workspace_authority', reason),
    });
    const result = await withDORetry(
      stub,
      async workspace =>
        workspace.reauthorize({
          expectedAuthorizationId,
          runtimeAuthorizationSeal: await sealRuntimeAuthorization(created.authorization, secret),
        }),
      'reauthorize'
    );
    if (result.status !== 'renewed' && result.status !== 'not-needed') {
      logger
        .withFields({ workspaceSessionId, status: result.status })
        .warn('Workspace Cloud Agent authority renewal refused');
    }
  } catch (error) {
    logger
      .withFields({
        workspaceSessionId,
        error: error instanceof Error ? error.name : 'unknown',
      })
      .warn('Workspace Cloud Agent authority renewal unavailable');
  }
}

import { withDORetry, withTimeout } from '@kilocode/worker-utils';
import { cloudAgentSyncLiveResultSchema } from '@kilocode/worker-utils/cloud-agent-session-sync';
import { getSessionSyncDOStub } from '../dos/SessionSyncDO';
import type { Env } from '../env';
import type { LiveTicket } from './ticket';

function failure(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: 'Live authorization is not available', retryable: status === 503 } },
    {
      status,
      headers: { 'Cache-Control': 'no-store', ...(status === 503 ? { 'Retry-After': '3' } : {}) },
    }
  );
}

async function hostingBinding(env: Env, ticket: LiveTicket, deadlineAt: number) {
  const sessionID = ticket.sessionID;
  if (!sessionID) return undefined;
  const authorized = await withDORetry(
    () => getSessionSyncDOStub(env, { tenant: ticket.tenant, sessionID }),
    async stub =>
      await stub.authorizeLive({
        principal: { userID: ticket.userID, tenant: ticket.tenant },
        sessionID,
      }),
    'authorizeRelaySession',
    { maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 500, scope: { deadlineAt } }
  );
  if (!authorized.ok) return failure(403, 'access_denied');
  return authorized.value.host;
}

export async function authorizeRelayTicket(
  env: Env,
  ticket: LiveTicket
): Promise<Response | undefined> {
  const deadlineAt = Date.now() + 4_000;
  try {
    return await withTimeout(
      (async () => {
        const host = await hostingBinding(env, ticket, deadlineAt);
        if (host instanceof Response) return host;
        if (ticket.role !== 'runner') return undefined;
        if (
          host?.cloudAgentSessionId !== ticket.host?.cloudAgentSessionId ||
          (host !== undefined && ticket.workload !== 'cloud-agent')
        )
          return failure(409, 'hosting_conflict');
        if (ticket.workload === undefined) return undefined;
        if (!host || !ticket.host || !ticket.native || !ticket.liveIdentity)
          return failure(409, 'hosting_conflict');
        return authorizeHostedTicket(env, ticket, deadlineAt);
      })(),
      4_500,
      'Relay authorization timed out'
    );
  } catch {
    return failure(503, 'auth_unavailable');
  }
}

export async function authorizeHostedTicket(
  env: Env,
  ticket: LiveTicket,
  deadlineAt = Date.now() + 4_000
): Promise<Response | undefined> {
  if (ticket.workload === undefined) return undefined;
  if (!ticket.host || !ticket.native || !ticket.liveIdentity) return failure(403, 'access_denied');
  try {
    if (!env.CLOUD_AGENT_SYNC_AUTH) return failure(503, 'auth_unavailable');
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return failure(503, 'auth_unavailable');
    const authorized = cloudAgentSyncLiveResultSchema.parse(
      await withTimeout(
        env.CLOUD_AGENT_SYNC_AUTH.authorizeLive({
          type: 'ticket',
          userID: ticket.userID,
          ...(ticket.tenant.type === 'organization' ? { organizationID: ticket.tenant.id } : {}),
          workload: ticket.workload,
          host: ticket.host,
          native: ticket.native,
          liveIdentity: ticket.liveIdentity,
        }),
        remainingMs,
        'Hosted authority timed out'
      )
    );
    if (authorized.type === 'unavailable') return failure(503, 'auth_unavailable');
    if (authorized.type !== 'allowed' || authorized.authorization.expiresAt < ticket.exp * 1000)
      return failure(403, 'access_denied');
    const current = authorized.authorization;
    if (
      current.userID !== ticket.userID ||
      current.organizationID !==
        (ticket.tenant.type === 'organization' ? ticket.tenant.id : undefined) ||
      current.host.cloudAgentSessionId !== ticket.host.cloudAgentSessionId ||
      current.native.sessionID !== ticket.native.sessionID ||
      current.native.rootSessionID !== ticket.native.rootSessionID ||
      current.native.kind !== ticket.native.kind ||
      current.liveIdentity.allocationId !== ticket.liveIdentity.allocationId ||
      current.liveIdentity.providerInstanceId !== ticket.liveIdentity.providerInstanceId
    )
      return failure(403, 'access_denied');
    return undefined;
  } catch {
    return failure(503, 'auth_unavailable');
  }
}

export async function authorizeRelayCommand(
  env: Env,
  ticket: LiveTicket
): Promise<Response | undefined> {
  try {
    const host = await withTimeout(
      hostingBinding(env, ticket, Date.now() + 4_000),
      4_500,
      'Command authorization timed out'
    );
    if (host instanceof Response) return host;
    return host === undefined ? undefined : failure(403, 'hosted_read_only');
  } catch {
    return failure(503, 'auth_unavailable');
  }
}

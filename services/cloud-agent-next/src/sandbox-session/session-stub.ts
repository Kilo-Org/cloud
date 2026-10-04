import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { SandboxSessionV2 } from '../control-plane/session/session-do.js';
import { sessionDoName, sessionFor } from '../session-plane.js';
import type { Env } from '../types.js';

export type SessionStubEnv = Pick<Env, 'CLOUD_AGENT_SESSION' | 'SANDBOX_SESSION'>;

export type SessionStub =
  | DurableObjectStub<CloudAgentSession>
  | DurableObjectStub<SandboxSessionV2>;

/**
 * The one stub-resolution point for either plane, built on `sessionFor`: a
 * control (`workspace_*`) session resolves to the V2 stub and a legacy
 * (`agent_*`) session to the legacy stub. The union type keeps callers on the
 * RPCs both planes implement; a call that only exists on one plane must use
 * `getSandboxSessionStub` (V2) or `resolveLegacySessionStub` (legacy).
 */
export function resolveSessionStub(
  env: SessionStubEnv,
  ownerId: string,
  sessionId: string
): SessionStub {
  return sessionFor(
    sessionId,
    () => getSandboxSessionStub(env, ownerId, sessionId),
    () => resolveLegacySessionStub(env, ownerId, sessionId)
  );
}

/** Legacy-plane only. Never call this from a `workspace_*` path. */
export function resolveLegacySessionStub(
  env: Pick<Env, 'CLOUD_AGENT_SESSION' | 'SANDBOX_SESSION'>,
  ownerId: string,
  sessionId: string
): DurableObjectStub<CloudAgentSession> {
  return env.CLOUD_AGENT_SESSION.get(
    env.CLOUD_AGENT_SESSION.idFromName(sessionDoName(ownerId, sessionId))
  );
}

export function getSandboxSessionStub(
  env: Pick<Env, 'SANDBOX_SESSION'>,
  ownerId: string,
  sessionId: string
): DurableObjectStub<SandboxSessionV2> {
  return env.SANDBOX_SESSION.get(
    env.SANDBOX_SESSION.idFromName(sessionDoName(ownerId, sessionId))
  ) as unknown as DurableObjectStub<SandboxSessionV2>;
}

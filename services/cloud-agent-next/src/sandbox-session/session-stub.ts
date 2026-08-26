import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import { sessionPlaneFromId } from '../session-plane.js';
import type { Env } from '../types.js';
import type { SandboxSession } from './SandboxSession.js';
export type { SessionClient } from './session-client.js';

export type SessionStubEnv = Pick<Env, 'CLOUD_AGENT_SESSION' | 'SANDBOX_SESSION'>;

export function resolveSessionStub(
  env: SessionStubEnv,
  ownerId: string,
  sessionId: string
): DurableObjectStub<CloudAgentSession> {
  const name = `${ownerId}:${sessionId}`;
  if (sessionPlaneFromId(sessionId) === 'control') {
    return env.SANDBOX_SESSION.get(
      env.SANDBOX_SESSION.idFromName(name)
    ) as unknown as DurableObjectStub<CloudAgentSession>;
  }
  return env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(name));
}

export function getSandboxSessionStub(
  env: Pick<Env, 'SANDBOX_SESSION'>,
  ownerId: string,
  sessionId: string
): DurableObjectStub<SandboxSession> {
  return env.SANDBOX_SESSION.get(env.SANDBOX_SESSION.idFromName(`${ownerId}:${sessionId}`));
}

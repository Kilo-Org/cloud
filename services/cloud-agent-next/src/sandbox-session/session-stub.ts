import type { SandboxSessionV2 } from '../control-plane/session/session-do.js';
import { sessionDoName } from '../session-identity.js';
import type { Env } from '../types.js';
import { assertControlSessionId } from '../session/session-id-guard.js';

export type SessionStubEnv = Pick<Env, 'SANDBOX_SESSION'>;
export type SessionStub = DurableObjectStub<SandboxSessionV2>;

export function getSandboxSessionStub(
  env: SessionStubEnv,
  ownerId: string,
  sessionId: string
): SessionStub {
  assertControlSessionId(sessionId);
  return env.SANDBOX_SESSION.get(env.SANDBOX_SESSION.idFromName(sessionDoName(ownerId, sessionId)));
}

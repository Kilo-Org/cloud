import { getSandbox } from '@cloudflare/sandbox';
import { findWrapperForSession } from '../kilo/wrapper-manager.js';
import { requiresContainmentSandbox } from '../persistence/session-metadata.js';
import { generateSandboxId, getSandboxNamespace } from '../sandbox-id.js';
import { fetchSessionMetadata } from '../session-service.js';
import type { Env, SandboxInstance, SandboxId, SessionId } from '../types.js';

export type SessionKiloFacadeDecision =
  | { kind: 'proxy-live-wrapper' }
  | { kind: 'reject'; status: number; code: string; message: string };

export type SessionKiloFacadePolicyInput = {
  method: string;
  kiloRelativePath: string;
  search: string;
  userId: string;
  kiloSessionId: string;
  cloudAgentSessionId: string;
};

export type LiveWrapperTarget = {
  sandbox: SandboxInstance;
  port: number;
};

export function buildWrapperKiloProxyUrl(params: {
  wrapperPort: number;
  kiloRelativePath: string;
  search: string;
}): string {
  const url = new URL(`http://localhost:${params.wrapperPort}/kilo-proxy`);
  url.pathname = `/kilo-proxy${params.kiloRelativePath}`;
  url.search = params.search;
  return url.toString();
}

export async function resolveLiveWrapperTarget(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<LiveWrapperTarget | null> {
  const { env, userId, cloudAgentSessionId } = params;
  const metadata = await fetchSessionMetadata(env, userId, cloudAgentSessionId);
  if (!metadata) {
    return null;
  }

  const sessionId = cloudAgentSessionId as SessionId;
  const sandboxId: SandboxId =
    metadata.workspace?.sandboxId ??
    (await generateSandboxId(
      env.PER_SESSION_SANDBOX_ORG_IDS,
      metadata.identity.orgId,
      userId,
      metadata.identity.sessionId,
      metadata.identity.botId,
      {
        createdOnPlatform: metadata.identity.createdOnPlatform,
      }
    ));

  const sandbox = getSandbox(
    getSandboxNamespace(env, sandboxId, {
      managedScmContainment: requiresContainmentSandbox(metadata),
    }),
    sandboxId
  );
  const wrapperInfo = await findWrapperForSession(sandbox, sessionId);
  if (!wrapperInfo) {
    return null;
  }

  return { sandbox, port: wrapperInfo.port };
}

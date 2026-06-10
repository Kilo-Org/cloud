import { getSandbox } from '@cloudflare/sandbox';
import { findWrapperForSession } from '../kilo/wrapper-manager.js';
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

export function decideSessionKiloFacadeRoute(
  input: SessionKiloFacadePolicyInput
): SessionKiloFacadeDecision {
  const suffix = input.kiloRelativePath.slice(
    `/session/${encodeURIComponent(input.kiloSessionId)}`.length
  );
  const supported =
    (input.method === 'GET' && (suffix === '' || suffix === '/message')) ||
    (input.method === 'POST' && (suffix === '/prompt_async' || suffix === '/abort'));
  if (!supported) {
    return {
      kind: 'reject',
      status: 501,
      code: 'KILO_ROUTE_UNSUPPORTED',
      message: 'Kilo facade route is not supported',
    };
  }
  return { kind: 'proxy-live-wrapper' };
}

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
      metadata.identity.botId
    ));

  const sandbox = getSandbox(getSandboxNamespace(env, sandboxId), sandboxId);
  const wrapperInfo = await findWrapperForSession(sandbox, sessionId);
  if (!wrapperInfo) {
    return null;
  }

  return { sandbox, port: wrapperInfo.port };
}

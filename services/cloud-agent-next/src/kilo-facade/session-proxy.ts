import { getSandbox } from '@cloudflare/sandbox';
import { findWrapperForSession } from '../kilo/wrapper-manager.js';
import { requiresContainmentSandbox } from '../persistence/session-metadata.js';
import { generateSandboxId, getSandboxNamespace } from '../sandbox-id.js';
import { fetchSessionMetadata } from '../session-service.js';
import { isControlSession } from '../session-plane.js';
import type { Env, SandboxInstance, SandboxId, SessionId } from '../types.js';
import {
  buildSandboxBillingInput,
  configureSandboxBillingInput,
  ensureSandboxBillingAdmissionInput,
  isSandboxBillingBlocked,
} from '../container-usage-context.js';
import type { SandboxBillingAdmissionResult } from '../container-usage-context.js';
import { isCloudAgentContainerBillingEnabled } from '../container-billing-rollout.js';
import { withDORetry } from '../utils/do-retry.js';

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

export type LiveWrapperResolution =
  | { kind: 'available'; target: LiveWrapperTarget }
  | { kind: 'unavailable' }
  | {
      kind: 'billing-rejected';
      admission: Extract<SandboxBillingAdmissionResult, { success: false }>;
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
}): Promise<LiveWrapperResolution> {
  const { env, userId, cloudAgentSessionId } = params;
  // A control-plane sandbox runs one supervisor per allocation and never a
  // per-session legacy wrapper process, so the lookup below cannot match it.
  // Touching the sandbox would only wake and bill it.
  if (isControlSession(cloudAgentSessionId)) return { kind: 'unavailable' };
  const metadata = await fetchSessionMetadata(env, userId, cloudAgentSessionId);
  if (!metadata) {
    return { kind: 'unavailable' };
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
        createdOnPlatform: metadata.identity.billingOrigin,
        legacyFallback: true,
      }
    ));

  const namespace = getSandboxNamespace(env, sandboxId, {
    managedScmContainment: requiresContainmentSandbox(metadata),
  });
  const resolveSandbox = () => getSandbox(namespace, sandboxId);
  let sandbox = resolveSandbox();
  const billingInput = buildSandboxBillingInput(
    metadata,
    sandboxId,
    isCloudAgentContainerBillingEnabled(env, metadata.identity)
  );
  const billingBlocked = await isSandboxBillingBlocked(sandbox, billingInput.enforcementRequested);
  if (billingInput.enforcementRequested || billingBlocked) {
    const admission = await ensureSandboxBillingAdmissionInput(sandbox, billingInput);
    if (!admission.success) return { kind: 'billing-rejected', admission };
  } else {
    sandbox = await withDORetry(
      resolveSandbox,
      async sandbox => {
        await configureSandboxBillingInput(sandbox, billingInput);
        return sandbox;
      },
      'configureSandboxBilling'
    );
  }
  const wrapperInfo = await findWrapperForSession(sandbox, sessionId);
  if (!wrapperInfo) {
    return { kind: 'unavailable' };
  }

  return { kind: 'available', target: { sandbox, port: wrapperInfo.port } };
}

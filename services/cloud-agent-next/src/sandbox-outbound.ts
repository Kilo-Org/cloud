import { z } from 'zod';
import {
  isControlPlaneCredential,
  parseControlPlaneCredential,
} from './sandbox-control/managed-credential.js';
import { withDORetry } from './utils/do-retry.js';
import {
  classifyScmAuthorization,
  type ResolvedScmCapability,
} from './scm-broker/authorization.js';
import { getSafeRequestLogFields, logDiagnostic } from './scm-broker/diagnostics.js';
import { forwardResolvedScmCapability } from './scm-broker/managed-forwarding.js';
import { forwardUnmanagedScmRequest } from './scm-broker/unmanaged-forwarding.js';
import {
  CURRENT_CAPABILITY_PREFIX,
  GITHUB_TASK_CAPABILITY_PREFIX,
} from '@kilocode/worker-utils/scm-capability-contract';

export { MANAGED_SCM_OUTBOUND_HANDLER } from './sandbox-id.js';

const resolvedControlCredentialSchema = z.object({ credential: z.string().min(1) }).strict();

type ControlCredentialResolutionBinding = {
  resolveCredential(input: {
    credential: string;
    outboundContainerId: string;
    url: string;
    method: string;
  }): Promise<unknown>;
};

type ManagedScmOutboundContext = { containerId: string };

function supportsControlCredentialResolution(
  service: unknown
): service is ControlCredentialResolutionBinding {
  return (
    typeof service === 'object' &&
    service !== null &&
    'resolveCredential' in service &&
    typeof service.resolveCredential === 'function'
  );
}

function sanitizedCredentialResolutionError(error: unknown): Error {
  return Object.assign(new Error('Control-plane authorization unavailable'), {
    retryable: error instanceof Error && 'retryable' in error && error.retryable === true,
  });
}

async function handleControlPlaneOutbound(
  request: Request,
  env: Cloudflare.Env,
  capability: ResolvedScmCapability,
  ctx: ManagedScmOutboundContext
): Promise<Response> {
  const parsed = parseControlPlaneCredential(capability.capability);
  const namespace = env.SANDBOX_CONTROL;
  if (!parsed || !namespace) {
    return new Response('SCM authorization unavailable', { status: 502 });
  }

  try {
    const resolved = resolvedControlCredentialSchema.safeParse(
      await withDORetry(
        () => {
          try {
            return namespace.getByName(parsed.sandboxId);
          } catch (error) {
            throw sanitizedCredentialResolutionError(error);
          }
        },
        async stub => {
          try {
            if (!supportsControlCredentialResolution(stub)) return null;
            return await stub.resolveCredential({
              credential: capability.capability,
              outboundContainerId: ctx.containerId,
              url: request.url,
              method: request.method,
            });
          } catch (error) {
            throw sanitizedCredentialResolutionError(error);
          }
        },
        'resolveControlPlaneCredential'
      )
    );
    if (!resolved.success) {
      return new Response('SCM authorization unavailable', { status: 502 });
    }
    const { credential } = resolved.data;
    const expectedPrefix =
      capability.provider === 'github'
        ? GITHUB_TASK_CAPABILITY_PREFIX
        : CURRENT_CAPABILITY_PREFIX[capability.provider];
    if (
      !credential.startsWith(expectedPrefix) ||
      credential.length === expectedPrefix.length ||
      /\s/.test(credential)
    ) {
      return new Response('SCM authorization unavailable', { status: 502 });
    }

    return await forwardResolvedScmCapability(
      request,
      env.GIT_TOKEN_SERVICE,
      { provider: capability.provider, capability: credential },
      ctx.containerId
    );
  } catch {
    return new Response('SCM authorization unavailable', { status: 502 });
  }
}

export function handleManagedScmOutbound(
  request: Request,
  env: Cloudflare.Env,
  ctx: ManagedScmOutboundContext
): Promise<Response> {
  const authorization = classifyScmAuthorization({
    authorization: request.headers.get('Authorization'),
    privateToken: request.headers.get('PRIVATE-TOKEN'),
  });
  const safeRequestLogFields = getSafeRequestLogFields(request);
  if (safeRequestLogFields.client === 'github-cli') {
    logDiagnostic(
      'debug',
      {
        ...safeRequestLogFields,
        authorizationClass: authorization.authorizationClass,
        outboundContainerId: ctx.containerId,
      },
      'Observed GitHub CLI outbound request'
    );
  }
  if (authorization.type === 'denied') {
    return Promise.resolve(new Response('SCM authorization unavailable', { status: 502 }));
  }
  if (authorization.type === 'unmanaged') return forwardUnmanagedScmRequest(request);
  const capability = authorization.value;
  if (isControlPlaneCredential(capability.capability)) {
    return handleControlPlaneOutbound(request, env, capability, ctx);
  }
  return forwardResolvedScmCapability(request, env.GIT_TOKEN_SERVICE, capability, ctx.containerId);
}

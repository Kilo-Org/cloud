import { billingContextSchema } from '@kilocode/container-usage';
import {
  SANDBOX_USAGE_SKUS,
  type SandboxClassName,
  type getSandboxBillingRuntimeStatus,
} from '../container-usage-context.js';
import { classifySandboxId, isIsolatedSandboxId } from '../sandbox-id.js';
import { decodeCloudflareProviderRef } from './cloudflare-provider.js';

export type SandboxTerminalAccessInput = {
  sessionId: string;
  ownerId: string;
  wrapperInstanceId: string;
  organizationId?: string;
  botId?: string;
};

export type SandboxTerminalAccessResult = {
  allowed: boolean;
  reason?: string;
};

type SandboxBillingRuntimeStatus = NonNullable<
  Awaited<ReturnType<typeof getSandboxBillingRuntimeStatus>>
>;

type TerminalBillingRuntimeInput = {
  access: SandboxTerminalAccessInput;
  sandboxId: string;
  providerInstanceId: string;
  sandboxDurableObjectId: string;
  runtime: SandboxBillingRuntimeStatus | undefined;
};

function expectedSandboxClassName(sandboxId: string): SandboxClassName | undefined {
  switch (classifySandboxId(sandboxId)) {
    case 'isolated-small':
      return 'SandboxSmallContainment';
    case 'code-review':
      return 'SandboxCodeReviewContainment';
    case 'isolated-standard':
    case 'shared':
    case 'legacy-shared':
      return 'SandboxContainment';
    default:
      return undefined;
  }
}

function expectedUsageService(sandboxClassName: SandboxClassName): string {
  return `cloud-agent-next-${sandboxClassName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

export function validateTerminalBillingRuntime(
  input: TerminalBillingRuntimeInput
): SandboxTerminalAccessResult {
  const runtime = input.runtime;
  if (!runtime) return { allowed: false, reason: 'billing_runtime_unavailable' };
  if (runtime.running !== true) {
    return { allowed: false, reason: 'billing_runtime_not_running' };
  }
  if (runtime.blocked !== false) return { allowed: false, reason: 'billing_blocked' };

  const parsed = billingContextSchema.safeParse(runtime.context);
  if (!parsed.success) return { allowed: false, reason: 'billing_context_unavailable' };

  const context = parsed.data;
  if (!context.measurementStarted) {
    return { allowed: false, reason: 'billing_context_unmeasured' };
  }
  if (context.pendingStop || context.stoppedObservedAtMs !== undefined) {
    return { allowed: false, reason: 'billing_generation_inactive' };
  }

  const sandboxClassName = expectedSandboxClassName(input.sandboxId);
  const providerRef = decodeCloudflareProviderRef(input.providerInstanceId);
  if (
    sandboxClassName === undefined ||
    providerRef?.sandboxId !== input.sandboxId ||
    runtime.sandboxClassName !== sandboxClassName ||
    context.instanceId !== input.sandboxId ||
    context.service !== expectedUsageService(sandboxClassName) ||
    context.sku !== SANDBOX_USAGE_SKUS[sandboxClassName] ||
    context.metadata?.container_class !== sandboxClassName ||
    context.metadata.durable_object_id !== input.sandboxDurableObjectId
  ) {
    return { allowed: false, reason: 'billing_runtime_mismatch' };
  }

  const expectedSubject = input.access.organizationId
    ? { type: 'org' as const, id: input.access.organizationId }
    : { type: 'user' as const, id: input.access.ownerId };
  if (context.subject.type !== expectedSubject.type || context.subject.id !== expectedSubject.id) {
    return { allowed: false, reason: 'billing_payer_mismatch' };
  }

  const expectedActor = input.access.botId
    ? { type: 'bot' as const, id: input.access.botId }
    : { type: 'user' as const, id: input.access.ownerId };
  if (context.actor.type !== expectedActor.type || context.actor.id !== expectedActor.id) {
    return { allowed: false, reason: 'billing_actor_mismatch' };
  }
  if (
    expectedActor.type === 'bot' &&
    (context.onBehalfOf?.type !== expectedSubject.type ||
      context.onBehalfOf.id !== expectedSubject.id)
  ) {
    return { allowed: false, reason: 'billing_actor_mismatch' };
  }

  const shared = !isIsolatedSandboxId(input.sandboxId);
  if (
    (shared && context.sessionId !== undefined) ||
    (!shared && context.sessionId !== input.access.sessionId)
  ) {
    return { allowed: false, reason: 'billing_session_mismatch' };
  }

  return { allowed: true };
}

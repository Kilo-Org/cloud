import { billingContextSchema } from '@kilocode/container-usage';
import type * as z from 'zod';
import {
  SANDBOX_USAGE_SKUS,
  isContainersBillingClassName,
  usageServiceForSandboxClass,
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

type ContainersTerminalBillingRuntimeInput = {
  access: SandboxTerminalAccessInput;
  sandboxId: string;
  providerInstanceId: string;
  sandboxDurableObjectId: string;
  runtime: SandboxBillingRuntimeStatus | undefined;
};

function expectedSandboxClassName(
  sandboxId: string,
  containment: boolean
): SandboxClassName | undefined {
  switch (classifySandboxId(sandboxId)) {
    case 'isolated-small':
      return containment ? 'SandboxSmallContainment' : 'SandboxSmall';
    case 'code-review':
      return containment ? 'SandboxCodeReviewContainment' : 'SandboxCodeReview';
    case 'isolated-standard':
    case 'shared':
    case 'legacy-shared':
      return containment ? 'SandboxContainment' : 'Sandbox';
    default:
      return undefined;
  }
}

type BillingContext = z.infer<typeof billingContextSchema>;

type BillingRuntimeGuard =
  | { ok: true; runtime: SandboxBillingRuntimeStatus; context: BillingContext }
  | { ok: false; reason: string };

function guardBillingRuntime(
  runtime: SandboxBillingRuntimeStatus | undefined
): BillingRuntimeGuard {
  if (!runtime) return { ok: false, reason: 'billing_runtime_unavailable' };
  if (runtime.running !== true) {
    return { ok: false, reason: 'billing_runtime_not_running' };
  }
  if (runtime.blocked !== false) return { ok: false, reason: 'billing_blocked' };

  const parsed = billingContextSchema.safeParse(runtime.context);
  if (!parsed.success) return { ok: false, reason: 'billing_context_unavailable' };

  const context = parsed.data;
  if (!context.measurementStarted) {
    return { ok: false, reason: 'billing_context_unmeasured' };
  }
  if (context.pendingStop || context.stoppedObservedAtMs !== undefined) {
    return { ok: false, reason: 'billing_generation_inactive' };
  }

  return { ok: true, runtime, context };
}

function matchesBillingContext(
  context: BillingContext,
  sandboxClassName: SandboxClassName,
  sandboxId: string,
  sandboxDurableObjectId: string
): boolean {
  return (
    context.instanceId === sandboxId &&
    context.service === usageServiceForSandboxClass(sandboxClassName) &&
    context.sku === SANDBOX_USAGE_SKUS[sandboxClassName] &&
    context.metadata?.container_class === sandboxClassName &&
    context.metadata.durable_object_id === sandboxDurableObjectId
  );
}

function billingAccessFailure(
  context: BillingContext,
  access: SandboxTerminalAccessInput,
  sandboxId: string
): string | undefined {
  const expectedSubject = access.organizationId
    ? { type: 'org' as const, id: access.organizationId }
    : { type: 'user' as const, id: access.ownerId };
  if (context.subject.type !== expectedSubject.type || context.subject.id !== expectedSubject.id) {
    return 'billing_payer_mismatch';
  }

  const expectedActor = access.botId
    ? { type: 'bot' as const, id: access.botId }
    : { type: 'user' as const, id: access.ownerId };
  if (context.actor.type !== expectedActor.type || context.actor.id !== expectedActor.id) {
    return 'billing_actor_mismatch';
  }
  if (
    expectedActor.type === 'bot' &&
    (context.onBehalfOf?.type !== expectedSubject.type ||
      context.onBehalfOf.id !== expectedSubject.id)
  ) {
    return 'billing_actor_mismatch';
  }

  const shared = !isIsolatedSandboxId(sandboxId);
  if (
    (shared && context.sessionId !== undefined) ||
    (!shared && context.sessionId !== access.sessionId)
  ) {
    return 'billing_session_mismatch';
  }

  return undefined;
}

export function validateTerminalBillingRuntime(
  input: TerminalBillingRuntimeInput
): SandboxTerminalAccessResult {
  const guard = guardBillingRuntime(input.runtime);
  if (!guard.ok) return { allowed: false, reason: guard.reason };
  const { runtime, context } = guard;

  const providerRef = decodeCloudflareProviderRef(input.providerInstanceId);
  if (providerRef?.sandboxId !== input.sandboxId) {
    return { allowed: false, reason: 'billing_runtime_mismatch' };
  }
  const sandboxClassName = expectedSandboxClassName(input.sandboxId, providerRef.containment);
  if (
    sandboxClassName === undefined ||
    runtime.sandboxClassName !== sandboxClassName ||
    !matchesBillingContext(context, sandboxClassName, input.sandboxId, input.sandboxDurableObjectId)
  ) {
    return { allowed: false, reason: 'billing_runtime_mismatch' };
  }

  const accessFailure = billingAccessFailure(context, input.access, input.sandboxId);
  if (accessFailure) return { allowed: false, reason: accessFailure };

  return { allowed: true };
}

export function validateContainersTerminalBillingRuntime(
  input: ContainersTerminalBillingRuntimeInput
): SandboxTerminalAccessResult {
  const guard = guardBillingRuntime(input.runtime);
  if (!guard.ok) return { allowed: false, reason: guard.reason };
  const { runtime, context } = guard;

  const providerRef = decodeCloudflareProviderRef(input.providerInstanceId);
  if (providerRef === null || classifySandboxId(providerRef.sandboxId) !== 'isolated-small') {
    return { allowed: false, reason: 'billing_runtime_mismatch' };
  }

  const sandboxClassName = runtime.sandboxClassName;
  if (
    !isContainersBillingClassName(sandboxClassName) ||
    !matchesBillingContext(context, sandboxClassName, input.sandboxId, input.sandboxDurableObjectId)
  ) {
    return { allowed: false, reason: 'billing_runtime_mismatch' };
  }

  const accessFailure = billingAccessFailure(context, input.access, input.sandboxId);
  if (accessFailure) return { allowed: false, reason: accessFailure };

  return { allowed: true };
}

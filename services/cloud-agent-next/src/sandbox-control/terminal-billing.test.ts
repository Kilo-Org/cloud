import type { BillingContext } from '@kilocode/container-usage';
import { describe, expect, it } from 'vitest';
import { SANDBOX_USAGE_SKUS, type SandboxClassName } from '../container-usage-context.js';
import {
  validateTerminalBillingRuntime,
  type SandboxTerminalAccessInput,
} from './terminal-billing.js';

const access: SandboxTerminalAccessInput = {
  sessionId: 'workspace_session',
  ownerId: 'user_owner',
  wrapperInstanceId: '8f54ab1b-df33-4324-bce3-42a76fd5a36b',
};

function context(overrides: Partial<BillingContext> = {}): BillingContext {
  return {
    service: 'cloud-agent-next-sandbox-small',
    instanceId: 'ses-abcdef',
    sku: SANDBOX_USAGE_SKUS.SandboxSmall,
    subject: { type: 'user', id: access.ownerId },
    actor: { type: 'user', id: access.ownerId },
    sessionId: access.sessionId,
    metadata: {
      container_class: 'SandboxSmall',
      durable_object_id: 'durable-object-small',
      origin: 'cloud-agent',
    },
    startEpochMs: 100,
    generation: '8ad114f7-7967-4abc-bcc1-ce0f9312413a',
    measurementStarted: true,
    nextSeq: 1,
    usageMeasuredAtMs: 100,
    ...overrides,
  };
}

function billingInput(
  options: {
    access?: SandboxTerminalAccessInput;
    sandboxId?: string;
    providerInstanceId?: string;
    sandboxDurableObjectId?: string;
    sandboxClassName?: SandboxClassName;
    running?: boolean;
    blocked?: boolean;
    context?: BillingContext;
  } = {}
) {
  const sandboxId = options.sandboxId ?? 'ses-abcdef';
  return {
    access: options.access ?? access,
    sandboxId,
    providerInstanceId: options.providerInstanceId ?? sandboxId,
    sandboxDurableObjectId: options.sandboxDurableObjectId ?? 'durable-object-small',
    runtime: {
      sandboxClassName: options.sandboxClassName ?? 'SandboxSmall',
      running: options.running ?? true,
      blocked: options.blocked ?? false,
      context: options.context ?? context(),
    },
  };
}

describe('validateTerminalBillingRuntime', () => {
  it('accepts a measured isolated runtime attributed to the session owner', () => {
    expect(validateTerminalBillingRuntime(billingInput())).toEqual({ allowed: true });
  });

  it.each([
    {
      sandboxId: 'crv-abcdef',
      sandboxClassName: 'SandboxCodeReview' as const,
      service: 'cloud-agent-next-sandbox-code-review',
    },
    {
      sandboxId: 'dind-abcdef',
      sandboxClassName: 'SandboxDIND' as const,
      service: 'cloud-agent-next-sandbox-dind',
    },
  ])('accepts measured $sandboxClassName attribution in its actual namespace', input => {
    expect(
      validateTerminalBillingRuntime(
        billingInput({
          sandboxId: input.sandboxId,
          sandboxClassName: input.sandboxClassName,
          context: context({
            service: input.service,
            instanceId: input.sandboxId,
            sku: SANDBOX_USAGE_SKUS[input.sandboxClassName],
            metadata: {
              container_class: input.sandboxClassName,
              durable_object_id: 'durable-object-small',
              origin: 'cloud-agent',
            },
          }),
        })
      )
    ).toEqual({ allowed: true });
  });

  it('accepts an organization bot acting for the matching payer', () => {
    const organizationAccess = { ...access, organizationId: 'org_team', botId: 'bot_worker' };
    expect(
      validateTerminalBillingRuntime(
        billingInput({
          access: organizationAccess,
          context: context({
            subject: { type: 'org', id: 'org_team' },
            actor: { type: 'bot', id: 'bot_worker' },
            onBehalfOf: { type: 'org', id: 'org_team' },
          }),
        })
      )
    ).toEqual({ allowed: true });
  });

  it('accepts a shared runtime only without session attribution', () => {
    const shared = billingInput({
      sandboxId: 'org-abcdef',
      sandboxClassName: 'Sandbox',
      context: context({
        service: 'cloud-agent-next-sandbox',
        instanceId: 'org-abcdef',
        sku: SANDBOX_USAGE_SKUS.Sandbox,
        sessionId: undefined,
        metadata: { container_class: 'Sandbox', durable_object_id: 'durable-object-small' },
      }),
    });

    expect(validateTerminalBillingRuntime(shared)).toEqual({ allowed: true });
    expect(
      validateTerminalBillingRuntime({
        ...shared,
        runtime: {
          ...shared.runtime,
          context: { ...shared.runtime.context, sessionId: access.sessionId },
        },
      })
    ).toEqual({ allowed: false, reason: 'billing_session_mismatch' });
  });

  it.each([
    {
      name: 'missing runtime',
      input: { ...billingInput(), runtime: undefined },
      reason: 'billing_runtime_unavailable',
    },
    {
      name: 'stopped runtime',
      input: billingInput({ running: false }),
      reason: 'billing_runtime_not_running',
    },
    {
      name: 'blocked runtime',
      input: billingInput({ blocked: true }),
      reason: 'billing_blocked',
    },
    {
      name: 'missing context',
      input: { ...billingInput(), runtime: { ...billingInput().runtime, context: undefined } },
      reason: 'billing_context_unavailable',
    },
    {
      name: 'unmeasured context',
      input: billingInput({ context: context({ measurementStarted: false }) }),
      reason: 'billing_context_unmeasured',
    },
    {
      name: 'stopped generation',
      input: billingInput({ context: context({ stoppedObservedAtMs: 150 }) }),
      reason: 'billing_generation_inactive',
    },
    {
      name: 'pending stop',
      input: billingInput({
        context: context({
          pendingStop: {
            seq: 1,
            usageSinceLast: 0,
            measuredAtMs: 150,
            reason: 'runtime_signal',
          },
        }),
      }),
      reason: 'billing_generation_inactive',
    },
  ])('rejects $name', ({ input, reason }) => {
    expect(validateTerminalBillingRuntime(input)).toEqual({ allowed: false, reason });
  });

  it.each([
    {
      name: 'sandbox class',
      input: billingInput({ sandboxClassName: 'SandboxCodeReview' }),
    },
    {
      name: 'provider instance',
      input: billingInput({ providerInstanceId: 'ses-other' }),
    },
    {
      name: 'billing instance',
      input: billingInput({ context: context({ instanceId: 'ses-other' }) }),
    },
    {
      name: 'service',
      input: billingInput({ context: context({ service: 'cloud-agent-next-sandbox' }) }),
    },
    {
      name: 'sku',
      input: billingInput({ context: context({ sku: SANDBOX_USAGE_SKUS.Sandbox }) }),
    },
    {
      name: 'namespace durable object',
      input: billingInput({ sandboxDurableObjectId: 'durable-object-other' }),
    },
    {
      name: 'container class metadata',
      input: billingInput({
        context: context({
          metadata: { container_class: 'Sandbox', durable_object_id: 'durable-object-small' },
        }),
      }),
    },
  ])('rejects mismatched $name', ({ input }) => {
    expect(validateTerminalBillingRuntime(input)).toEqual({
      allowed: false,
      reason: 'billing_runtime_mismatch',
    });
  });

  it('rejects a different organization payer', () => {
    expect(
      validateTerminalBillingRuntime(
        billingInput({
          access: { ...access, organizationId: 'org_expected' },
          context: context({ subject: { type: 'org', id: 'org_other' } }),
        })
      )
    ).toEqual({ allowed: false, reason: 'billing_payer_mismatch' });
  });

  it('rejects a different organization actor', () => {
    expect(
      validateTerminalBillingRuntime(
        billingInput({
          access: { ...access, organizationId: 'org_team' },
          context: context({
            subject: { type: 'org', id: 'org_team' },
            actor: { type: 'user', id: 'user_other' },
          }),
        })
      )
    ).toEqual({ allowed: false, reason: 'billing_actor_mismatch' });
  });

  it('rejects isolated attribution for a different session', () => {
    expect(
      validateTerminalBillingRuntime(
        billingInput({ context: context({ sessionId: 'workspace_other' }) })
      )
    ).toEqual({ allowed: false, reason: 'billing_session_mismatch' });
  });
});

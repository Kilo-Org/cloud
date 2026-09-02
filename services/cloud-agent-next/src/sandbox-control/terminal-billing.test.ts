import type { BillingContext } from '@kilocode/container-usage';
import { describe, expect, it } from 'vitest';
import { SANDBOX_USAGE_SKUS, type SandboxClassName } from '../container-usage-context.js';
import { encodeCloudflareProviderRef } from './cloudflare-provider.js';
import {
  validateTerminalBillingRuntime,
  type SandboxTerminalAccessInput,
} from './terminal-billing.js';

const PROVIDER_CREATION_ID = 'd1b3a0a8-a0a4-48a3-ab59-4be8bd63ba9a';

const access: SandboxTerminalAccessInput = {
  sessionId: 'workspace_session',
  ownerId: 'user_owner',
  wrapperInstanceId: '8f54ab1b-df33-4324-bce3-42a76fd5a36b',
};

function context(overrides: Partial<BillingContext> = {}): BillingContext {
  return {
    service: 'cloud-agent-next-sandbox-small-containment',
    instanceId: 'ses-abcdef',
    sku: SANDBOX_USAGE_SKUS.SandboxSmallContainment,
    subject: { type: 'user', id: access.ownerId },
    actor: { type: 'user', id: access.ownerId },
    sessionId: access.sessionId,
    metadata: {
      container_class: 'SandboxSmallContainment',
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
    containment?: boolean;
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
    providerInstanceId:
      options.providerInstanceId ??
      encodeCloudflareProviderRef({
        sandboxId,
        containment: options.containment ?? true,
        instanceId: PROVIDER_CREATION_ID,
      }),
    sandboxDurableObjectId: options.sandboxDurableObjectId ?? 'durable-object-small',
    runtime: {
      sandboxClassName: options.sandboxClassName ?? 'SandboxSmallContainment',
      running: options.running ?? true,
      blocked: options.blocked ?? false,
      context: options.context ?? context(),
    },
  };
}

describe('validateTerminalBillingRuntime', () => {
  it('accepts a measured contained runtime attributed to the session owner', () => {
    expect(validateTerminalBillingRuntime(billingInput())).toEqual({ allowed: true });
  });

  it.each([
    {
      sandboxId: 'istd-abcdef',
      sandboxClassName: 'Sandbox' as const,
      service: 'cloud-agent-next-sandbox',
      expected: { allowed: false, reason: 'billing_runtime_mismatch' },
    },
    {
      sandboxId: 'crv-abcdef',
      sandboxClassName: 'SandboxCodeReviewContainment' as const,
      service: 'cloud-agent-next-sandbox-code-review-containment',
      expected: { allowed: true },
    },
    {
      sandboxId: 'istd-abcdef',
      sandboxClassName: 'SandboxContainment' as const,
      service: 'cloud-agent-next-sandbox-containment',
      expected: { allowed: true },
    },
  ])(
    'validates measured $sandboxClassName attribution against the containment namespace',
    input => {
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
      ).toEqual(input.expected);
    }
  );

  it.each([
    {
      sandboxId: 'ses-abcdef',
      sandboxClassName: 'SandboxSmall' as const,
      service: 'cloud-agent-next-sandbox-small',
    },
    {
      sandboxId: 'crv-abcdef',
      sandboxClassName: 'SandboxCodeReview' as const,
      service: 'cloud-agent-next-sandbox-code-review',
    },
    {
      sandboxId: 'istd-abcdef',
      sandboxClassName: 'Sandbox' as const,
      service: 'cloud-agent-next-sandbox',
    },
    {
      sandboxId: 'org-abcdef',
      sandboxClassName: 'Sandbox' as const,
      service: 'cloud-agent-next-sandbox',
    },
  ])('accepts uncontained $sandboxClassName only with its matching fenced reference', input => {
    const uncontained = billingInput({
      sandboxId: input.sandboxId,
      sandboxClassName: input.sandboxClassName,
      containment: false,
      context: context({
        service: input.service,
        instanceId: input.sandboxId,
        sku: SANDBOX_USAGE_SKUS[input.sandboxClassName],
        ...(input.sandboxId.startsWith('org-') ? { sessionId: undefined } : {}),
        metadata: {
          container_class: input.sandboxClassName,
          durable_object_id: 'durable-object-small',
        },
      }),
    });
    expect(validateTerminalBillingRuntime(uncontained)).toEqual({ allowed: true });
    expect(
      validateTerminalBillingRuntime({
        ...uncontained,
        providerInstanceId: encodeCloudflareProviderRef({
          sandboxId: input.sandboxId,
          containment: true,
          instanceId: PROVIDER_CREATION_ID,
        }),
      })
    ).toEqual({ allowed: false, reason: 'billing_runtime_mismatch' });
    expect(
      validateTerminalBillingRuntime({ ...uncontained, sandboxDurableObjectId: 'other-namespace' })
    ).toEqual({ allowed: false, reason: 'billing_runtime_mismatch' });
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

  it.each(['org-abcdef', 'usr-abcdef', 'bot-abcdef', 'ubt-abcdef'])(
    'accepts shared containment runtime %s only without session attribution',
    sandboxId => {
      const shared = billingInput({
        sandboxId,
        sandboxClassName: 'SandboxContainment',
        context: context({
          service: 'cloud-agent-next-sandbox-containment',
          instanceId: sandboxId,
          sku: SANDBOX_USAGE_SKUS.SandboxContainment,
          sessionId: undefined,
          metadata: {
            container_class: 'SandboxContainment',
            durable_object_id: 'durable-object-small',
          },
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
    }
  );

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
    { name: 'raw sandbox ID', providerInstanceId: 'ses-abcdef' },
    { name: 'empty reference', providerInstanceId: '' },
    { name: 'invalid JSON', providerInstanceId: '{' },
    { name: 'JSON sandbox ID string', providerInstanceId: JSON.stringify('ses-abcdef') },
    {
      name: 'uncontained reference',
      providerInstanceId: JSON.stringify({
        sandboxId: 'ses-abcdef',
        containment: false,
        instanceId: PROVIDER_CREATION_ID,
      }),
    },
    {
      name: 'reference without a creation identity',
      providerInstanceId: JSON.stringify({ sandboxId: 'ses-abcdef', containment: true }),
    },
  ])('rejects $name instead of falling back to an uncontained runtime', input => {
    expect(validateTerminalBillingRuntime(billingInput(input))).toEqual({
      allowed: false,
      reason: 'billing_runtime_mismatch',
    });
  });

  it.each([
    {
      sandboxId: 'ses-abcdef',
      sandboxClassName: 'SandboxSmall' as const,
      service: 'cloud-agent-next-sandbox-small',
    },
    {
      sandboxId: 'crv-abcdef',
      sandboxClassName: 'SandboxCodeReview' as const,
      service: 'cloud-agent-next-sandbox-code-review',
    },
    {
      sandboxId: 'org-abcdef',
      sandboxClassName: 'Sandbox' as const,
      service: 'cloud-agent-next-sandbox',
    },
    {
      sandboxId: 'dind-abcdef',
      sandboxClassName: 'SandboxDIND' as const,
      service: 'cloud-agent-next-sandbox-dind',
    },
    {
      sandboxId: 'invalid-id',
      sandboxClassName: 'SandboxContainment' as const,
      service: 'cloud-agent-next-sandbox-containment',
    },
  ])('rejects $sandboxId in $sandboxClassName despite otherwise matching billing', input => {
    expect(
      validateTerminalBillingRuntime(
        billingInput({
          sandboxId: input.sandboxId,
          sandboxClassName: input.sandboxClassName,
          context: context({
            service: input.service,
            instanceId: input.sandboxId,
            sku: SANDBOX_USAGE_SKUS[input.sandboxClassName],
            ...(input.sandboxId.startsWith('org-') ? { sessionId: undefined } : {}),
            metadata: {
              container_class: input.sandboxClassName,
              durable_object_id: 'durable-object-small',
            },
          }),
        })
      )
    ).toEqual({ allowed: false, reason: 'billing_runtime_mismatch' });
  });

  it.each([
    {
      name: 'sandbox class',
      input: billingInput({ sandboxClassName: 'SandboxCodeReviewContainment' }),
    },
    {
      name: 'provider sandbox',
      input: billingInput({
        providerInstanceId: encodeCloudflareProviderRef({
          sandboxId: 'ses-fedcba',
          containment: true,
          instanceId: PROVIDER_CREATION_ID,
        }),
      }),
    },
    {
      name: 'creation identity used as the billing instance',
      input: billingInput({ context: context({ instanceId: PROVIDER_CREATION_ID }) }),
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

  it.each([
    undefined,
    { type: 'org' as const, id: 'org_other' },
    { type: 'user' as const, id: access.ownerId },
  ])('rejects a bot whose on-behalf-of attribution does not match the payer: %s', onBehalfOf => {
    expect(
      validateTerminalBillingRuntime(
        billingInput({
          access: { ...access, organizationId: 'org_team', botId: 'bot_worker' },
          context: context({
            subject: { type: 'org', id: 'org_team' },
            actor: { type: 'bot', id: 'bot_worker' },
            onBehalfOf,
          }),
        })
      )
    ).toEqual({ allowed: false, reason: 'billing_context_unavailable' });
  });

  it.each([undefined, 'workspace_other'])(
    'rejects isolated attribution without the requested session: %s',
    sessionId => {
      expect(
        validateTerminalBillingRuntime(billingInput({ context: context({ sessionId }) }))
      ).toEqual({ allowed: false, reason: 'billing_session_mismatch' });
    }
  );
});

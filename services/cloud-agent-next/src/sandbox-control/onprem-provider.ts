import { z } from 'zod';
import * as onprem from '../onprem/client.js';
import { sameSandboxProviderBinding } from '../sandbox-provider-binding.js';
import {
  decodeOnPremProviderRef,
  encodeOnPremProviderRef,
  onPremProfileSchema,
  onPremProviderBindingSchema,
  type OnPremProviderBinding,
} from '../shared/onprem-protocol.js';
import type { Env } from '../types.js';
import { DEADLINE_MS } from './deadlines.js';
import type { CreateIntent } from './physical-lifecycle.js';
import type { ProviderAdapter } from './provider.js';

const onPremCreateIntentSchema = z
  .object({
    intentId: z.uuid().toLowerCase(),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    allocationName: z.string().min(1).max(256),
    containment: z.object({
      kilocode: z.literal(true),
      github: z.literal(true),
      worktreeScoped: z.literal(true),
    }),
    onprem: z
      .object({
        binding: onPremProviderBindingSchema,
        profile: onPremProfileSchema,
        hardStopAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .refine(intent => intent.onprem.profile.id === intent.onprem.binding.profileId)
  .refine(
    intent => intent.onprem.hardStopAt === intent.createdAt + intent.onprem.profile.maxLifetimeMs
  );

export class OnPremLifetimeError extends Error {
  constructor() {
    super('On-prem allocation has insufficient fixed lifetime');
    this.name = 'OnPremLifetimeError';
  }
}

export class OnPremAcknowledgementPendingError extends Error {
  constructor() {
    super('On-prem allocation awaits its first management acknowledgement');
    this.name = 'OnPremAcknowledgementPendingError';
  }
}

export function parseOnPremCreateIntent(
  intent: CreateIntent | null | undefined,
  binding: OnPremProviderBinding
): z.infer<typeof onPremCreateIntentSchema> {
  const parsed = onPremCreateIntentSchema.safeParse(intent);
  if (!parsed.success || !sameSandboxProviderBinding(parsed.data.onprem.binding, binding)) {
    throw new Error('On-prem allocation requires its pinned profile and provider binding');
  }
  return parsed.data;
}

export function createOnPremProviderAdapter(deps: {
  env: Pick<Env, 'ONPREM_INSTALLATION'>;
  binding: OnPremProviderBinding;
  sandboxId: string;
  intent?: CreateIntent | null;
}): ProviderAdapter {
  const binding = onPremProviderBindingSchema.parse(deps.binding);
  const ownedReference = (ref: string | null, intent = deps.intent): string | null => {
    const allocationId = z.uuid().toLowerCase().safeParse(intent?.intentId);
    const providerRef =
      ref ??
      (intent?.onprem !== undefined && allocationId.success
        ? encodeOnPremProviderRef({
            installationId: binding.installationId,
            allocationId: allocationId.data,
          })
        : null);
    const identity = decodeOnPremProviderRef(providerRef);
    return identity &&
      identity.installationId === binding.installationId &&
      (!intent || (allocationId.success && identity.allocationId === allocationId.data))
      ? encodeOnPremProviderRef(identity)
      : null;
  };

  return {
    resumable: false,
    async ensureBillingAdmission() {},
    async create(intent) {
      const pinned = parseOnPremCreateIntent(intent, binding);
      if (intent.networkPolicy !== undefined) {
        throw new Error('On-prem allocations do not accept Vercel network policies');
      }
      if (Date.now() >= pinned.onprem.hardStopAt) throw new OnPremLifetimeError();
      const expectedRef = encodeOnPremProviderRef({
        installationId: binding.installationId,
        allocationId: pinned.intentId,
      });
      const reserved = await onprem.reserveAllocation(deps.env, {
        binding,
        allocationId: pinned.intentId,
        sandboxId: deps.sandboxId,
        allocationName: pinned.allocationName,
        createdAt: pinned.createdAt,
        profile: pinned.onprem.profile,
      });
      if (
        reserved.providerRef !== expectedRef ||
        reserved.hardStopAt !== pinned.onprem.hardStopAt
      ) {
        throw new Error('On-prem reservation does not match its create intent');
      }
      return { providerRef: reserved.providerRef };
    },
    async launch(ref, env) {
      const pinned = parseOnPremCreateIntent(deps.intent, binding);
      const providerRef = ownedReference(ref, pinned);
      if (!providerRef) throw new Error('Invalid on-prem sandbox allocation');
      const notAfter = Math.min(pinned.createdAt + DEADLINE_MS.startup, pinned.onprem.hardStopAt);
      if (Date.now() >= notAfter) throw new Error('On-prem wrapper bootstrap expired');
      await onprem.launchAllocation(deps.env, binding.organizationId, {
        providerRef,
        bootstrap: { ...env, PROVIDER_INSTANCE_ID: providerRef },
        notAfter,
      });
    },
    async observe(ref, intent) {
      const target = intent ?? deps.intent;
      if (ref === null && target && target.onprem === undefined) return { status: 'terminal' };
      const providerRef = ownedReference(ref, target);
      if (!providerRef) return { status: 'unknown' };
      try {
        const observation = await onprem.observeAllocation(
          deps.env,
          binding.organizationId,
          providerRef
        );
        return observation.providerRef === providerRef
          ? observation
          : { status: 'unknown', providerRef };
      } catch {
        return { status: 'unknown', providerRef };
      }
    },
    async stop(ref, intent) {
      const target = intent ?? deps.intent;
      if (ref === null && target && target.onprem === undefined) return 'terminal';
      const providerRef = ownedReference(ref, target);
      if (!providerRef) return 'retryable';
      try {
        return await onprem.stopAllocation(deps.env, binding.organizationId, providerRef);
      } catch {
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, ms) {
      const providerRef = ownedReference(ref);
      if (!providerRef || !Number.isFinite(ms) || ms < 0) {
        throw new Error('Invalid on-prem lifetime request');
      }
      const pinned = parseOnPremCreateIntent(deps.intent, binding);
      if (pinned.onprem.hardStopAt <= Date.now() || pinned.onprem.hardStopAt - Date.now() < ms) {
        throw new OnPremLifetimeError();
      }
      const allocation = await onprem.getAllocation(deps.env, binding.organizationId, providerRef);
      if (
        !allocation ||
        allocation.providerRef !== providerRef ||
        allocation.allocationId !== pinned.intentId ||
        allocation.sandboxId !== deps.sandboxId ||
        allocation.allocationName !== pinned.allocationName ||
        allocation.createdAt !== pinned.createdAt ||
        !sameSandboxProviderBinding(allocation.binding, binding) ||
        allocation.profile.revision !== pinned.onprem.profile.revision ||
        allocation.hardStopAt !== pinned.onprem.hardStopAt
      ) {
        throw new Error('On-prem allocation lifetime does not match its create intent');
      }
      const now = Date.now();
      if (allocation.hardStopAt <= now || allocation.hardStopAt - now < ms) {
        throw new OnPremLifetimeError();
      }
      if (
        allocation.phase === 'launched' &&
        allocation.status === 'unknown' &&
        allocation.pod !== null &&
        allocation.acknowledgedAt === null &&
        !allocation.acknowledgementFresh
      ) {
        throw new OnPremAcknowledgementPendingError();
      }
      if (
        allocation.status !== 'active' ||
        allocation.phase !== 'launched' ||
        allocation.pod === null ||
        !allocation.acknowledgementFresh ||
        allocation.acknowledgedAt === null ||
        allocation.acknowledgedAt > now
      ) {
        throw new Error('On-prem allocation lifetime is not acknowledged');
      }
    },
    async logs(ref) {
      const providerRef = ownedReference(ref);
      if (!providerRef) throw new Error('Invalid on-prem sandbox allocation');
      return `onprem ${providerRef}`;
    },
  };
}

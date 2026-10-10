import { z } from 'zod';
import { agentSandboxProviderSchema } from '../../types.js';
import { sandboxProviderConfigurationSchema } from '../../sandbox-control/provider.js';
import { sandboxBillingInputEnvelopeSchema } from '../../container-usage-context.js';
import { credentialContainmentSchema } from '../../sandbox-control/credential-containment.js';
import {
  controlPlaneCredentialSourceSchema,
  controlPlaneRouteSpecSchema,
} from '../../shared/control-plane-protocol.js';

/**
 * DO-only sandbox selection (H1). The Worker owns selection (H2) and carries the
 * chosen provider/allocation/billing/containment into `prepare`; the Sandbox DO
 * applies it to its provider pin while the allocation is `stopped`. Same private
 * boundary as the credential source: it never reaches the wrapper.
 */
export const controlPlaneSandboxSelectionSchema = z
  .object({
    provider: agentSandboxProviderSchema,
    allocationName: z.string().min(1).max(256).optional(),
    configuration: sandboxProviderConfigurationSchema.optional(),
    billing: sandboxBillingInputEnvelopeSchema.optional(),
    containment: credentialContainmentSchema.optional(),
  })
  .strict();

export type ControlPlaneSandboxSelection = z.infer<typeof controlPlaneSandboxSelectionSchema>;

/**
 * Extended `prepare` input. Kept out of `shared/control-plane-protocol.ts` so the
 * shared protocol stays free of Cloudflare-worker-only imports (the wrapper
 * typechecks `src/shared/**` without the generated worker globals).
 */
export const controlPlanePrepareInputWithSelectionSchema = z
  .object({
    spec: controlPlaneRouteSpecSchema,
    credentials: controlPlaneCredentialSourceSchema,
    sandboxSelection: controlPlaneSandboxSelectionSchema.optional(),
  })
  .strict();

export type ControlPlanePrepareInputWithSelection = z.infer<
  typeof controlPlanePrepareInputWithSelectionSchema
>;

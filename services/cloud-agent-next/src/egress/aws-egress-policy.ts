import type { ScopedScmGrant } from '../scm-broker/scoped-admission.js';
import {
  AWS_EGRESS_POLICY_TTL_MS,
  AWS_EGRESS_PROTOCOL_VERSION,
  awsEgressPolicySchema,
} from '@kilocode/worker-utils/aws-egress';
import { STANDARD_SCM_HOSTS } from '@kilocode/worker-utils/scm-capability-contract';
import { activeScopedScmGrants } from '../scm-broker/scoped-admission.js';
import { managedScmHosts } from '../scm-broker/targets.js';
import type {
  AwsEgressIdentity,
  AwsEgressProof,
  AwsScopedEgressContext,
} from './aws-egress-identity.js';
import {
  AwsEgressAdmissionError as AdmissionFailure,
  awsEgressFailureResponse,
} from './aws-egress-error.js';

/** Projects the allowlist assembled by the shared builder in the owning context. */
export async function awsEgressPolicy<
  G extends ScopedScmGrant,
  C extends AwsScopedEgressContext<G>,
>(
  identity: AwsEgressIdentity<G, C>,
  proof: AwsEgressProof,
  memberIds: (grant: G) => readonly string[]
): Promise<Response> {
  try {
    return await identity.accepted(proof, async (context, authenticated) => {
      const interceptedHosts = [
        ...new Set(
          activeScopedScmGrants(context, identity.now(), memberIds).flatMap(managedScmHosts)
        ),
      ].sort();
      if (interceptedHosts.some(host => !STANDARD_SCM_HOSTS.includes(host)))
        throw new AdmissionFailure(403, 'scm_host_unsupported');
      const configuration = context.operation.config;
      return Response.json(
        awsEgressPolicySchema.parse({
          protocolVersion: AWS_EGRESS_PROTOCOL_VERSION,
          generation: configuration.proxy.generation,
          stackId: configuration.stackId,
          sandboxId: context.sandboxId,
          allocationId: authenticated.claims.allocationId,
          allocationRef: context.allocation.providerRef,
          validUntil: Math.min(identity.now() + AWS_EGRESS_POLICY_TTL_MS, authenticated.expiresAt),
          ...(context.allowlist === undefined ? {} : { allowlist: context.allowlist }),
          audit: context.audit,
          interceptedHosts,
        })
      );
    });
  } catch (error) {
    return awsEgressFailureResponse(error);
  }
}

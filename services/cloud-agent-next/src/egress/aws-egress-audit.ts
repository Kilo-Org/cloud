import type { ScopedScmGrant } from '../scm-broker/scoped-admission.js';
import { withTimeout } from '@kilocode/worker-utils';
import { EgressAuditRequestSchema } from '@kilocode/worker-utils/egress-audit';
import type { Env } from '../types.js';
import type {
  AwsEgressIdentity,
  AwsEgressProof,
  AwsScopedEgressContext,
} from './aws-egress-identity.js';
import {
  AwsEgressAdmissionError as AdmissionFailure,
  awsEgressFailureResponse,
} from './aws-egress-error.js';
import { egressAuditStore } from './sandbox-egress.js';

export async function recordAwsEgressAudit<
  G extends ScopedScmGrant,
  C extends AwsScopedEgressContext<G>,
>(
  deps: { env: Env; identity: AwsEgressIdentity<G, C> },
  proof: AwsEgressProof,
  value: unknown
): Promise<Response> {
  try {
    const row = EgressAuditRequestSchema.parse(value);
    const admitted = await deps.identity.accepted(proof, async (context, identity) => {
      if (
        !context.audit ||
        row.allocationRef !== context.allocation.providerRef ||
        Math.abs(Date.parse(row.timestamp) - deps.identity.now()) > 60_000
      )
        throw new AdmissionFailure(403, 'audit_denied');
      return { sandboxId: context.sandboxId, identity };
    });
    await withTimeout(
      egressAuditStore(deps.env, { logicalSandboxId: admitted.sandboxId }).recordEgressRequest(row),
      5_000,
      'AWS egress audit unavailable'
    );
    await deps.identity.withCurrent(admitted.identity, () => undefined);
    return new Response(null, { status: 204 });
  } catch (error) {
    return awsEgressFailureResponse(error);
  }
}

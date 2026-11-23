/** This module owns AWS sandbox egress context assembly. */
import type { Env } from '../types.js';
import type { ByocSource } from '../byoc/owner.js';
import { readAwsEgressOperation } from '../control-plane/sandbox/aws-operation-storage.js';
import type { ScmAdmissionContext, ScmAdmissionDependencies } from '../scm-broker/admission.js';
import { createAwsEgressAdmission } from './aws-admission.js';
import { buildNativeEgressAllowlist } from '../sandbox-control/egress-policy.js';

type SandboxContext = Omit<ScmAdmissionContext, 'available' | 'identityBinding'> & {
  byoc?: ByocSource;
};

export function createAwsSandboxEgress(deps: {
  env: Env;
  admission: Pick<ScmAdmissionDependencies, 'serial' | 'resolve' | 'persist'>;
  readContext(): Promise<SandboxContext>;
  operationStorage: Parameters<typeof readAwsEgressOperation>[0]['storage'];
  readCredentialHash(): Promise<string | undefined>;
  readPolicy(): { allowlist?: readonly string[]; audit: boolean };
}) {
  return createAwsEgressAdmission({
    env: deps.env,
    ...deps.admission,
    readContext: async () => {
      const context = await deps.readContext();
      const operation = await readAwsEgressOperation({
        provider: context.provider,
        providerRef: context.allocation.providerRef,
        sandboxId: context.sandboxId,
        storage: deps.operationStorage,
      });
      const policy = deps.readPolicy();
      // The stored request pin stays immutable. Compute-specific routing uses the same allowlist owner.
      const allowlist =
        policy.allowlist === undefined || !operation
          ? policy.allowlist
          : buildNativeEgressAllowlist({
              env: deps.env,
              allowlist: policy.allowlist,
              providerRoutingTargets: [
                `https://${operation.config.bucket}.s3.${operation.config.region}.amazonaws.com`,
              ],
            });
      return {
        ...context,
        available: context.provider === 'aws' || context.provider === 'aws-ecs',
        identityBinding: '',
        operation,
        credentialHash: await deps.readCredentialHash(),
        audit: policy.audit,
        allowlist,
      };
    },
  });
}

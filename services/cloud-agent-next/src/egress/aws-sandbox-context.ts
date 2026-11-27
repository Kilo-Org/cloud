/** This module owns AWS sandbox egress context assembly. */
import type { Env } from '../types.js';
import type { ByocSource } from '../byoc/owner.js';
import { awsOperationSchema, decodeAwsProviderRef } from '../sandbox-control/aws-operation.js';
import { awsOperationStorage } from '../control-plane/sandbox/aws-operation-storage.js';
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
  operationStorage: Parameters<typeof awsOperationStorage>[0];
  readCredentialHash(): Promise<string | undefined>;
  readPolicy(): { allowlist?: readonly string[]; audit: boolean };
}) {
  const operations = awsOperationStorage(deps.operationStorage);
  return createAwsEgressAdmission({
    env: deps.env,
    ...deps.admission,
    readContext: async () => {
      const context = await deps.readContext();
      const ref = decodeAwsProviderRef(context.allocation.providerRef);
      const operation =
        ref?.sandboxId === context.sandboxId
          ? (awsOperationSchema.safeParse(await operations.get(ref.intentId)).data ?? null)
          : null;
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
        available: context.provider === 'aws',
        identityBinding: '',
        operation,
        credentialHash: await deps.readCredentialHash(),
        audit: policy.audit,
        allowlist,
      };
    },
  });
}

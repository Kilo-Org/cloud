import type { ScmAdmissionDependencies } from '../scm-broker/admission.js';
import {
  createAwsEgressIdentity,
  type AwsEgressIdentityDeps,
  type AwsEgressProof,
} from './aws-egress-identity.js';
import { awsEgressPolicy } from './aws-egress-policy.js';
import { recordAwsEgressAudit } from './aws-egress-audit.js';
import { admitAwsScm, type AwsScmAdmission } from './aws-scm-admission.js';

export type { AwsEgressProof, AwsEgressContext } from './aws-egress-identity.js';
export type { AwsScmAdmission } from './aws-scm-admission.js';

/** One identity owner, separate endpoint decisions, and no request-body transport. */
export function createAwsEgressAdmission(
  deps: AwsEgressIdentityDeps & Pick<ScmAdmissionDependencies, 'resolve' | 'persist'>
) {
  const identity = createAwsEgressIdentity(deps);
  return {
    policy: (proof: AwsEgressProof) => awsEgressPolicy(identity, proof),
    audit: (proof: AwsEgressProof, value: unknown) =>
      recordAwsEgressAudit({ env: deps.env, identity }, proof, value),
    admitScm: (proof: AwsEgressProof, request: AwsScmAdmission) =>
      admitAwsScm({ identity, resolve: deps.resolve, persist: deps.persist }, proof, request),
  };
}

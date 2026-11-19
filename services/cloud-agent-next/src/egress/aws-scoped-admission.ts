import type { Env } from '../types.js';
import type { ByocSource } from '../byoc/owner.js';
import type { AwsProxyMetadata } from '../byoc/aws-proxy.js';
import type {
  ScopedScmGrant,
  ScopedScmAdmissionDependencies,
} from '../scm-broker/scoped-admission.js';
import {
  createAwsEgressIdentity,
  type AwsScopedEgressContext,
  type AwsEgressConfiguration,
  type AwsEgressIdentityClaims,
  type AwsEgressProof,
} from './aws-egress-identity.js';
import { awsEgressPolicy } from './aws-egress-policy.js';
import { recordAwsEgressAudit } from './aws-egress-audit.js';
import { admitAwsScm, type AwsScmAdmission } from './aws-scm-admission.js';
export type {
  AwsEgressProof,
  AwsEgressConfiguration,
  AwsEgressOperation,
  AwsScopedEgressContext,
} from './aws-egress-identity.js';

export function createAwsScopedEgressAdmission<
  G extends ScopedScmGrant,
  C extends AwsScopedEgressContext<G>,
>(deps: {
  env: Env;
  serial: ScopedScmAdmissionDependencies<G, C>['serial'];
  readContext: () => Promise<C>;
  resolve: ScopedScmAdmissionDependencies<G, C>['resolve'];
  persist: ScopedScmAdmissionDependencies<G, C>['persist'];
  memberIds: (grant: G) => readonly string[];
  verifyCredential(
    token: string,
    secret: string,
    context: C,
    now: number
  ): AwsEgressIdentityClaims | null;
  resolveConfiguration?: (
    source: ByocSource,
    provider: 'aws' | 'aws-ecs'
  ) => Promise<AwsEgressConfiguration>;
  readMetadata?: (configuration: AwsEgressConfiguration) => Promise<AwsProxyMetadata>;
  signingSecret?: () => Promise<string | undefined>;
  now?: () => number;
}) {
  const identity = createAwsEgressIdentity<G, C>(deps);
  return {
    policy: (proof: AwsEgressProof) => awsEgressPolicy(identity, proof, deps.memberIds),
    audit: (proof: AwsEgressProof, value: unknown) =>
      recordAwsEgressAudit({ env: deps.env, identity }, proof, value),
    admitScm: (proof: AwsEgressProof, request: AwsScmAdmission) =>
      admitAwsScm({ ...deps, identity }, proof, request),
  };
}

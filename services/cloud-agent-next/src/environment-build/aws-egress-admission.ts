import type { ByocSource } from '../byoc/owner.js';
import type { Env } from '../types.js';
import {
  createAwsScopedEgressAdmission,
  type AwsScopedEgressContext,
} from '../egress/aws-scoped-admission.js';
import type { AwsEc2ByocConfiguration } from '@kilocode/worker-utils/aws-ec2';
import type { ScopedScmAdmissionDependencies } from '../scm-broker/scoped-admission.js';
import type { BuildScmGrant } from './scm-credentials.js';

export type AwsBuildEgressContext = AwsScopedEgressContext<BuildScmGrant> & {
  environmentId: string;
  buildId: string;
  actorUserId: string;
};

/** Build membership is real build authority; no Session or model grant is constructed. */
export function createAwsBuildEgressAdmission(deps: {
  env: Env;
  serial: ScopedScmAdmissionDependencies<BuildScmGrant, AwsBuildEgressContext>['serial'];
  readContext(): Promise<AwsBuildEgressContext>;
  resolve: ScopedScmAdmissionDependencies<BuildScmGrant, AwsBuildEgressContext>['resolve'];
  persist: ScopedScmAdmissionDependencies<BuildScmGrant, AwsBuildEgressContext>['persist'];
  resolveEc2Configuration?: (source: ByocSource) => Promise<AwsEc2ByocConfiguration>;
  signingSecret?: () => Promise<string | undefined>;
  now?: () => number;
}) {
  return createAwsScopedEgressAdmission<BuildScmGrant, AwsBuildEgressContext>({
    ...deps,
    readContext: async () => {
      const context = await deps.readContext();
      return {
        ...context,
        identityBinding: JSON.stringify([
          'environment-build',
          context.environmentId,
          context.buildId,
          context.actorUserId,
          context.byoc?.credentialId,
          context.identityBinding,
        ]),
      };
    },
    memberIds: grant => [grant.buildId],
  });
}

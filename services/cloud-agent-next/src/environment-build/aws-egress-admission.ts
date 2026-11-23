import type { ByocSource } from '../byoc/owner.js';
import type { AwsProxyMetadata } from '../byoc/aws-proxy.js';
import type { Env } from '../types.js';
import {
  createAwsScopedEgressAdmission,
  type AwsScopedEgressContext,
  type AwsEgressConfiguration,
} from '../egress/aws-scoped-admission.js';
import type { ScopedScmAdmissionDependencies } from '../scm-broker/scoped-admission.js';
import type { BuildScmGrant } from './scm-credentials.js';
import { verifyAwsBuildEgressCredential } from './aws-egress-credential.js';

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
  resolveConfiguration?: (
    source: ByocSource,
    provider: 'aws' | 'aws-ecs'
  ) => Promise<AwsEgressConfiguration>;
  readMetadata?: (configuration: AwsEgressConfiguration) => Promise<AwsProxyMetadata>;
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
    verifyCredential(token, secret, context, now) {
      const claims = verifyAwsBuildEgressCredential(token, secret, now);
      if (
        !claims ||
        claims.environmentId !== context.environmentId ||
        claims.buildId !== context.buildId ||
        claims.actorUserId !== context.actorUserId ||
        claims.provider !== context.provider ||
        claims.credentialId !== context.byoc?.credentialId
      )
        return null;
      return claims;
    },
  });
}

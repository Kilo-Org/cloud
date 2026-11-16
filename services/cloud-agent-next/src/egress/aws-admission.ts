import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import {
  sessionScmAdmissionContext,
  sessionScmMemberIds,
  type ScmAdmissionContext,
  type ScmAdmissionDependencies,
} from '../scm-broker/admission.js';
import type { Env } from '../types.js';
import type { ByocSource } from '../byoc/owner.js';
import type { AwsProxyMetadata } from '../byoc/aws-proxy.js';
import { verifyAwsEgressCredential } from './aws-credential.js';
import {
  createAwsScopedEgressAdmission,
  type AwsEgressOperation,
  type AwsEgressConfiguration,
} from './aws-scoped-admission.js';
export type { AwsEgressProof, AwsEgressOperation } from './aws-scoped-admission.js';

export type AwsEgressContext = ScmAdmissionContext & {
  byoc?: ByocSource;
  operation: AwsEgressOperation | null;
  credentialHash?: string;
  allowlist?: readonly string[];
  audit: boolean;
};

/** Session authority retains runtime readiness and live Session DO membership. */
export function createAwsEgressAdmission(deps: {
  env: Env;
  serial: ScmAdmissionDependencies['serial'];
  readContext: () => Promise<AwsEgressContext>;
  resolve: ScmAdmissionDependencies['resolve'];
  persist: ScmAdmissionDependencies['persist'];
  resolveConfiguration?: (
    source: ByocSource,
    provider: 'aws' | 'aws-ecs'
  ) => Promise<AwsEgressConfiguration>;
  readMetadata?: (configuration: AwsEgressConfiguration) => Promise<AwsProxyMetadata>;
  signingSecret?: () => Promise<string | undefined>;
  now?: () => number;
}) {
  type Context = ReturnType<typeof sessionScmAdmissionContext<AwsEgressContext>>;
  return createAwsScopedEgressAdmission<SessionCredentialGrant, Context>({
    ...deps,
    readContext: async () =>
      sessionScmAdmissionContext({ ...(await deps.readContext()), identityBinding: 'session' }),
    memberIds: sessionScmMemberIds,
    verifyCredential: (token, secret, _context, now) =>
      verifyAwsEgressCredential(token, secret, now),
  });
}

export type { AwsScmAdmission } from './aws-scm-admission.js';

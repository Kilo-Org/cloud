/** This module owns AWS sandbox egress context assembly and session admission. */
import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';
import type { Env } from '../types.js';
import type { ByocSource } from '../byoc/owner.js';
import type { AwsProxyMetadata } from '../byoc/aws-proxy.js';
import { readAwsEgressOperation } from '../control-plane/sandbox/aws-operation-storage.js';
import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import {
  sessionScmAdmissionContext,
  sessionScmMemberIds,
  type ScmAdmissionContext,
  type ScmAdmissionDependencies,
} from '../scm-broker/admission.js';
import { buildNativeEgressAllowlist } from '../sandbox-control/egress-policy.js';
import { verifyAwsEgressCredential } from './aws-credential.js';
import { createAwsScopedEgressAdmission } from './aws-scoped-admission.js';

type SandboxContext = Omit<ScmAdmissionContext, 'available' | 'identityBinding'> & {
  byoc?: ByocSource;
};

/** Session authority retains runtime readiness and live Session DO membership. */
export function createAwsSandboxEgress(deps: {
  env: Env;
  admission: Pick<ScmAdmissionDependencies, 'serial' | 'resolve' | 'persist'>;
  readContext(): Promise<SandboxContext>;
  operationStorage: Parameters<typeof readAwsEgressOperation>[0]['storage'];
  readCredentialHash(): Promise<string | undefined>;
  readPolicy(): { allowlist?: readonly string[]; audit: boolean };
  resolveConfiguration?: (source: ByocSource) => Promise<AwsEcsByocConfiguration>;
  readMetadata?: (configuration: AwsEcsByocConfiguration) => Promise<AwsProxyMetadata>;
  signingSecret?: () => Promise<string | undefined>;
  now?: () => number;
}) {
  async function readContext() {
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
    return sessionScmAdmissionContext({
      ...context,
      available: context.provider === 'aws-ecs',
      identityBinding: 'session',
      operation,
      credentialHash: await deps.readCredentialHash(),
      audit: policy.audit,
      allowlist,
    });
  }
  return createAwsScopedEgressAdmission<
    SessionCredentialGrant,
    Awaited<ReturnType<typeof readContext>>
  >({
    env: deps.env,
    ...deps.admission,
    readContext,
    memberIds: sessionScmMemberIds,
    verifyCredential: (token, secret, _context, now) =>
      verifyAwsEgressCredential(token, secret, now),
    resolveConfiguration: deps.resolveConfiguration,
    readMetadata: deps.readMetadata,
    signingSecret: deps.signingSecret,
    now: deps.now,
  });
}

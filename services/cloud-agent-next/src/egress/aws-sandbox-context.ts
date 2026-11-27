/** This module owns AWS sandbox egress context assembly and session admission. */
import type { AwsEc2ByocConfiguration } from '@kilocode/worker-utils/aws-ec2';
import type { Env } from '../types.js';
import type { ByocSource } from '../byoc/owner.js';
import { readAwsEc2EgressWorkspace } from '../control-plane/sandbox/aws-ec2-storage.js';
import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import {
  sessionScmAdmissionContext,
  sessionScmMemberIds,
  type ScmAdmissionContext,
  type ScmAdmissionDependencies,
} from '../scm-broker/admission.js';
import { buildNativeEgressAllowlist } from '../sandbox-control/egress-policy.js';
import { createAwsScopedEgressAdmission } from './aws-scoped-admission.js';

type SandboxContext = Omit<ScmAdmissionContext, 'available' | 'identityBinding'> & {
  byoc?: ByocSource;
};

/** Session authority retains runtime readiness and live Session DO membership. */
export function createAwsSandboxEgress(deps: {
  env: Env;
  admission: Pick<ScmAdmissionDependencies, 'serial' | 'resolve' | 'persist'>;
  readContext(): Promise<SandboxContext>;
  operationStorage: Parameters<typeof readAwsEc2EgressWorkspace>[0];
  readPolicy(): { allowlist?: readonly string[]; audit: boolean };
  resolveEc2Configuration?: (source: ByocSource) => Promise<AwsEc2ByocConfiguration>;
  signingSecret?: () => Promise<string | undefined>;
  now?: () => number;
}) {
  async function readContext() {
    const context = await deps.readContext();
    const ec2 =
      context.provider === 'aws-ec2'
        ? await readAwsEc2EgressWorkspace(deps.operationStorage, context.allocation.providerRef)
        : null;
    const policy = deps.readPolicy();
    // The stored request pin stays immutable. Compute-specific routing uses the same allowlist owner.
    const allowlist =
      policy.allowlist === undefined || !ec2
        ? policy.allowlist
        : buildNativeEgressAllowlist({
            env: deps.env,
            allowlist: policy.allowlist,
            providerRoutingTargets: [],
          });
    return sessionScmAdmissionContext({
      ...context,
      available: context.provider === 'aws-ec2',
      identityBinding: 'session',
      ec2,
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
    resolveEc2Configuration: deps.resolveEc2Configuration,
    signingSecret: deps.signingSecret,
    now: deps.now,
  });
}

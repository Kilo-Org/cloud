import {
  controlPlaneScmForwardAdmissionSchema,
  type ControlPlaneScmForwardAdmission,
  type ControlPlaneScmForwardAdmissionResult,
} from '../shared/control-plane-protocol.js';
import { isAllowedEgressUrl } from '@kilocode/worker-utils/egress-allowlist';
import { STANDARD_SCM_HOSTS } from '@kilocode/worker-utils/scm-capability-contract';
import { admitScmRequest, type ScmAdmissionDependencies } from '../scm-broker/admission.js';
import type { AwsEgressIdentity, AwsEgressProof } from './aws-egress-identity.js';
import {
  AwsEgressAdmissionError as AdmissionFailure,
  awsEgressFailure,
} from './aws-egress-error.js';

export type AwsScmAdmission = Omit<ControlPlaneScmForwardAdmission, 'oidcToken'>;
const scmAdmissionSchema = controlPlaneScmForwardAdmissionSchema.omit({ oidcToken: true });

export async function admitAwsScm(
  deps: Pick<ScmAdmissionDependencies, 'resolve' | 'persist'> & {
    identity: AwsEgressIdentity;
  },
  proof: AwsEgressProof,
  request: AwsScmAdmission
): Promise<ControlPlaneScmForwardAdmissionResult> {
  try {
    const parsed = scmAdmissionSchema.safeParse(request);
    if (!parsed.success) return { ok: false, status: 403, code: 'invalid_request' };
    const target = new URL(parsed.data.target.url);
    if (
      target.port ||
      target.username ||
      target.password ||
      target.hash ||
      target.protocol !== 'https:' ||
      !isAllowedEgressUrl(target, STANDARD_SCM_HOSTS)
    )
      throw new AdmissionFailure(403, 'target_denied');
    let authenticated: Awaited<ReturnType<typeof deps.identity.authenticate>> | undefined;
    const admission = await admitScmRequest(parsed.data, {
      serial: deps.identity.serial,
      readContext: deps.identity.readContext,
      resolve: deps.resolve,
      persist: deps.persist,
      async authenticate(context) {
        const identity = await deps.identity.authenticate(context, proof);
        authenticated = identity;
        return { ok: true, isCurrent: () => identity.expiresAt > deps.identity.now() };
      },
    });
    if (!admission.ok) return admission;
    if (!authenticated) throw new AdmissionFailure(403, 'invalid_identity');
    const identity = authenticated;
    // Validate the current egress policy too. A managed host is never an allowlist bypass.
    await deps.identity.withCurrent(identity, context => {
      if (context.allowlist !== undefined && !isAllowedEgressUrl(target, context.allowlist))
        throw new AdmissionFailure(403, 'destination_denied');
    });
    return admission;
  } catch (error) {
    return { ok: false, ...awsEgressFailure(error) };
  }
}

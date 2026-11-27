import { NextResponse } from 'next/server';
import type { StepUpRequirementPayload } from '@kilocode/web-shared/lib/admin/privileged-access';
import { stepUpPolicyFor } from '@kilocode/web-shared/lib/admin/step-up-policy';
import type { requireStaffAuthorityForRequest } from '@kilocode/web-shared/lib/user/server';

type StaffAuthorityParams = Parameters<typeof requireStaffAuthorityForRequest>[1];
type StaffAuthorityResult = Awaited<ReturnType<typeof requireStaffAuthorityForRequest>>;

/**
 * The REST adapter's `MFA_REQUIRED` refusal for exactly the admission it was
 * asked for: a read-class request needs a session proof, while a write-class
 * request needs a proof bound to this operation and target. The response
 * body therefore shows which class and target the route requested.
 */
export function staffStepUpRefusal(
  params: StaffAuthorityParams,
  route: string
): StaffAuthorityResult {
  const policy = stepUpPolicyFor(params.actionClass);
  const stepUp: StepUpRequirementPayload = {
    code: 'MFA_REQUIRED',
    actionClass: params.actionClass,
    purpose: policy.purpose,
    maxAgeSeconds: policy.maxAgeMs / 1000,
    binding:
      policy.purpose === 'operation'
        ? {
            actionClass: params.actionClass,
            surface: params.surface ?? 'rest',
            route,
            method: (params.requestMethod ?? '').toLowerCase(),
            targetKind: params.target.kind,
            targetId: params.target.id,
          }
        : null,
  };
  return {
    user: null,
    authFailedResponse: NextResponse.json(
      { success: false, error: stepUp.code, stepUp },
      { status: 403 }
    ),
    stepUp,
  };
}

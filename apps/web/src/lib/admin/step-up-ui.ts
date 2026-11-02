import 'server-only';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { ADMIN_STEP_UP_ENROLLMENT_FLAG } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { getAdminStepUpMode } from '@kilocode/web-shared/lib/config.server';

/**
 * Whether the admin shell should show any step-up surface at all.
 *
 * With the mode off the console must look exactly as it did before PR2, except
 * when the enrollment rollout is explicitly on for this admin; only then is
 * there something to show. In observe mode the shell shows status because that
 * is the point of the rollout.
 */
export async function isAdminStepUpUiVisible(user: {
  id: string;
  is_admin: boolean;
}): Promise<boolean> {
  return adminStepUpUiRule({
    isAdmin: user.is_admin,
    mode: getAdminStepUpMode(),
    enrollmentEnabled: () => isReleaseToggleEnabled(ADMIN_STEP_UP_ENROLLMENT_FLAG, user.id),
  });
}

/** Dependency-injected rule so the mode/toggle matrix is unit-testable. */
export async function adminStepUpUiRule(params: {
  isAdmin: boolean;
  mode: 'off' | 'observe' | 'enforce';
  enrollmentEnabled: () => Promise<boolean>;
}): Promise<boolean> {
  if (!params.isAdmin) return false;
  if (params.mode !== 'off') return true;
  return params.enrollmentEnabled();
}

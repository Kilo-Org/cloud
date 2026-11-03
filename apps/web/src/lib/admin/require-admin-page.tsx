import 'server-only';
import { redirect } from 'next/navigation';
import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { stepUpErrorCodeForState } from '@kilocode/web-shared/lib/admin/step-up-guard';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { AdminStepUpInterstitial } from '@/components/admin/step-up/AdminStepUpInterstitial';
import type { StepUpRequirement } from '@/components/admin/step-up/step-up-error';

type AdminPageAccess = { user: User; stepUp: null } | { user: null; stepUp: StepUpRequirement };

/**
 * Auth for admin pages that need the user row. When ON and the session is not
 * verified, returns a gate instead of redirecting, so the current URL survives
 * verification. Real non-admins still go to `/admin/unauthorized`.
 */
export async function requireAdminPage(): Promise<AdminPageAccess> {
  const auth = await getUserFromAuth({
    adminOnly: true,
    stepUpSurface: 'server-component',
    skipStepUpGuard: true,
  });
  if (!auth.user) {
    redirect('/admin/unauthorized');
  }

  if (!isAdminStepUpEnabled()) {
    return { user: auth.user, stepUp: null };
  }

  if (auth.credential !== 'session') {
    return { user: null, stepUp: { code: 'BEARER_NOT_ALLOWED' } };
  }

  try {
    const evaluation = await evaluateStepUp({
      userId: auth.user.id,
      webSessionId: auth.webSessionId,
      actionClass: 'platform_read',
    });
    if (evaluation.state.status !== 'fresh') {
      return { user: null, stepUp: { code: stepUpErrorCodeForState(evaluation.state) } };
    }
  } catch {
    return { user: null, stepUp: { code: 'STEP_UP_UNAVAILABLE' } };
  }

  return { user: auth.user, stepUp: null };
}

export function AdminStepUpGate({ requirement }: { requirement: StepUpRequirement }) {
  return <AdminStepUpInterstitial requirement={requirement} />;
}

import 'server-only';
import { redirect } from 'next/navigation';
import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { AdminStepUpInterstitial } from '@/components/admin/step-up/AdminStepUpInterstitial';
import type { StepUpRequirement } from '@/components/admin/step-up/step-up-error';

type AdminPageAccess = { user: User; stepUp: null } | { user: null; stepUp: StepUpRequirement };

/**
 * Auth for admin pages that need the user row. It runs the same staff
 * admission as the layout. When the session still needs step-up, it returns a
 * gate instead of redirecting, so the current URL survives verification. Real
 * non-admins and refused networks still go to `/admin/unauthorized`.
 */
export async function requireAdminPage(): Promise<AdminPageAccess> {
  const auth = await getUserFromAuth({ adminOnly: true, stepUpSurface: 'server-component' });
  if (auth.user) return { user: auth.user, stepUp: null };
  if (auth.stepUp) return { user: null, stepUp: { code: auth.stepUp.code } };
  redirect('/admin/unauthorized');
}

export function AdminStepUpGate({ requirement }: { requirement: StepUpRequirement }) {
  return <AdminStepUpInterstitial requirement={requirement} />;
}

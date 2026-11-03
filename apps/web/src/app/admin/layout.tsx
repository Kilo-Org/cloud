import React from 'react';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import UnauthorizedPage from './unauthorized/page';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './components/AppSidebar';
import { Toaster } from '@/components/ui/sonner';
import { BuildInfo } from '@/app/admin/components/BuildInfo';
import { AppShellSkipLink } from '@/components/AppShellSkipLink';
import { isSupportAccessEnabled } from '@kilocode/web-shared/lib/admin/support-access';
import { AdminStepUpInterstitial } from '@/components/admin/step-up/AdminStepUpInterstitial';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { stepUpErrorCodeForState } from '@kilocode/web-shared/lib/admin/step-up-guard';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';
import type { StepUpRequirement } from '@/components/admin/step-up/step-up-error';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const auth = await getUserFromAuth({
    adminOnly: true,
    stepUpSurface: 'server-component',
    skipStepUpGuard: true,
  });
  const currentUser = auth.user;

  if (!currentUser) {
    return <UnauthorizedPage />;
  }

  let stepUpRequirement: StepUpRequirement | null = null;
  if (isAdminStepUpEnabled()) {
    if (auth.credential !== 'session') {
      stepUpRequirement = { code: 'BEARER_NOT_ALLOWED' };
    } else {
      try {
        const evaluation = await evaluateStepUp({
          userId: currentUser.id,
          webSessionId: auth.webSessionId,
          actionClass: 'platform_read',
        });
        if (evaluation.state.status !== 'fresh') {
          stepUpRequirement = { code: stepUpErrorCodeForState(evaluation.state) };
        }
      } catch (error) {
        reportStepUpFailure('admin_step_up_layout', error);
        stepUpRequirement = { code: 'STEP_UP_UNAVAILABLE' };
      }
    }
  }

  // One verification surface only: when the session needs step-up, render the
  // interstitial without the sidebar so no admin query opens a second dialog.
  if (stepUpRequirement) {
    return (
      <main id="main-content" tabIndex={-1}>
        <AdminStepUpInterstitial requirement={stepUpRequirement} variant="page" />
      </main>
    );
  }

  return (
    <div className="flex min-h-screen">
      <SidebarProvider>
        <AppShellSkipLink />
        <AppSidebar variant="inset" supportAccessEnabled={isSupportAccessEnabled()}>
          {/* Need to pass BuildInfo as children from a server component to make it have access to the right variables */}
          <BuildInfo />
        </AppSidebar>
        <SidebarInset>
          <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </div>
  );
}

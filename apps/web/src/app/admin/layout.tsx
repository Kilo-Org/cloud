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
import { AdminAccessDenied } from '@/app/admin/components/AdminAccessDenied';
import { adminNetworkRefusalFor } from '@kilocode/web-shared/lib/admin/admin-network';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // The same staff admission as every admin request: current role, network,
  // browser session and a live session proof when step-up is on.
  const auth = await getUserFromAuth({ adminOnly: true, stepUpSurface: 'server-component' });

  if (!auth.user) {
    if (auth.adminNetworkDenial) {
      return (
        <AdminAccessDenied message={adminNetworkRefusalFor(auth.adminNetworkDenial).message} />
      );
    }
    // One verification surface only: when the session needs step-up, render the
    // interstitial without the sidebar so no admin query opens a second dialog.
    if (auth.stepUp) {
      return (
        <main id="main-content" tabIndex={-1}>
          <AdminStepUpInterstitial requirement={{ code: auth.stepUp.code }} variant="page" />
        </main>
      );
    }
    return <UnauthorizedPage />;
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

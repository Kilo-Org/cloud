import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import UnauthorizedPage from './unauthorized/page';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './components/AppSidebar';
import { Toaster } from '@/components/ui/sonner';
import { BuildInfo } from '@/app/admin/components/BuildInfo';
import { AppShellSkipLink } from '@/components/AppShellSkipLink';
import { AdminStepUpStatus } from '@/components/admin/step-up/AdminStepUpStatus';
import { StepUpProvider } from '@/components/admin/step-up/StepUpProvider';
import { isAdminStepUpUiVisible } from '@/lib/admin/step-up-ui';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user: currentUser } = await getUserFromAuth({
    adminOnly: true,
    stepUpSurface: 'server-component',
  });

  if (!currentUser) {
    return <UnauthorizedPage />;
  }

  const showStepUp = await isAdminStepUpUiVisible(currentUser);

  return (
    <div className="flex min-h-screen">
      <SidebarProvider>
        <AppShellSkipLink />
        <AppSidebar variant="inset">
          {/* Need to pass BuildInfo as children from a server component to make it have access to the right variables */}
          <BuildInfo />
        </AppSidebar>
        <SidebarInset>
          <StepUpProvider>
            <AdminStepUpStatus visible={showStepUp} />
            <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
              {children}
            </main>
          </StepUpProvider>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </div>
  );
}

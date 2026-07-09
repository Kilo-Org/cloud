import { getUserFromAuth } from '@/lib/user/server';
import UnauthorizedPage from './unauthorized/page';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './components/AppSidebar';
import { Toaster } from '@/components/ui/sonner';
import { BuildInfo } from '@/app/admin/components/BuildInfo';
import { AppShellSkipLink } from '@/components/AppShellSkipLink';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user: currentUser } = await getUserFromAuth({ adminOnly: true });

  if (!currentUser) {
    return <UnauthorizedPage />;
  }

  return (
    <div className="flex min-h-screen">
      <SidebarProvider>
        <AppShellSkipLink />
        <AppSidebar variant="inset">
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

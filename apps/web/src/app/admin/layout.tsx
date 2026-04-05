import { getUserFromAuth } from '@/lib/user.server';
import UnauthorizedPage from './unauthorized/page';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './components/AppSidebar';
import { Toaster } from '@/components/ui/sonner';
import { BuildInfo } from '@/app/admin/components/BuildInfo';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user: currentUser } = await getUserFromAuth({ adminOnly: true });

  if (!currentUser) {
    return <UnauthorizedPage />;
  }

  return (
    <div className="flex min-h-screen">
      <SidebarProvider>
        <AppSidebar variant="inset">
          {/* Need to pass BuildInfo as children from a server component to make it have access to the right variables */}
          <BuildInfo />
        </AppSidebar>
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
      <Toaster />
    </div>
  );
}

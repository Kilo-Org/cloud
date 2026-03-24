import AppSidebar from './components/AppSidebar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import { AdminOmnibox } from '@/components/admin-omnibox';
import { PrefetchedOrganizations } from './components/PrefetchedOrganizations';
import { TopBarProvider, TopBar } from '@/components/TopBar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleTestingProvider>
      <SidebarProvider>
        <PrefetchedOrganizations>
          <TopBarProvider>
            <div className="flex min-h-screen w-full">
              <AppSidebar />
              <SidebarInset>
                <TopBar />
                {/* Main content */}
                <main className="bg-background w-full flex-1">{children}</main>
              </SidebarInset>
            </div>
          </TopBarProvider>
        </PrefetchedOrganizations>
      </SidebarProvider>
      <AdminOmnibox />
    </RoleTestingProvider>
  );
}

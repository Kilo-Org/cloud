import AppSidebar from './components/AppSidebar';
import { AppTopbar } from './components/AppTopbar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import { PageTitleProvider } from '@/contexts/PageTitleContext';
import { AdminOmnibox } from '@/components/admin-omnibox';
import { PrefetchedOrganizations } from './components/PrefetchedOrganizations';
import { ImpactIdentify } from '@/components/ImpactIdentify';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleTestingProvider>
      <PageTitleProvider>
        <SidebarProvider>
          <ImpactIdentify />
          <PrefetchedOrganizations>
            <div className="flex min-h-screen w-full">
              <AppSidebar />
              <SidebarInset>
                <AppTopbar />
                <main className="bg-background w-full flex-1">{children}</main>
              </SidebarInset>
            </div>
          </PrefetchedOrganizations>
        </SidebarProvider>
      </PageTitleProvider>
      <AdminOmnibox />
    </RoleTestingProvider>
  );
}

import AppSidebar from './components/AppSidebar';
import { AppTopbar } from './components/AppTopbar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import { PageTitleProvider } from '@/contexts/PageTitleContext';
import { EventServiceProvider } from '@/contexts/EventServiceContext';
import { AdminOmnibox } from '@/components/admin-omnibox';
import { PrefetchedOrganizations } from './components/PrefetchedOrganizations';
import { PlatformPresenceMount } from './components/PlatformPresenceMount';
import { ImpactIdentify } from '@/components/ImpactIdentify';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleTestingProvider>
      <PageTitleProvider>
        <EventServiceProvider>
          <PlatformPresenceMount />
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
        </EventServiceProvider>
      </PageTitleProvider>
      <AdminOmnibox />
    </RoleTestingProvider>
  );
}

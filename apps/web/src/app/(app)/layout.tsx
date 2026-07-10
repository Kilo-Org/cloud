import { Suspense } from 'react';
import AppSidebar from './components/AppSidebar';
import { AppTopbar } from './components/AppTopbar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import { PageTitleProvider } from '@/contexts/PageTitleContext';
import { EventServiceProvider } from '@/contexts/EventServiceContext';
import { AdminOmnibox } from '@/components/admin-omnibox';
import { AppShellSkipLink } from '@/components/AppShellSkipLink';
import { PrefetchedOrganizations } from './components/PrefetchedOrganizations';
import { PlatformPresenceMount } from './components/PlatformPresenceMount';
import { CustomerSourceSurvey } from '@/components/CustomerSourceSurvey';
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleTestingProvider>
      <PageTitleProvider>
        <EventServiceProvider>
          <PlatformPresenceMount />
          <SidebarProvider>
            <PrefetchedOrganizations>
              <AppShellSkipLink />
              <div className="flex min-h-screen w-full">
                <Suspense fallback={null}>
                  <AppSidebar />
                </Suspense>
                <SidebarInset>
                  <AppTopbar />
                  <main id="main-content" tabIndex={-1} className="bg-background w-full flex-1">
                    {children}
                  </main>
                </SidebarInset>
              </div>
            </PrefetchedOrganizations>
          </SidebarProvider>
          <CustomerSourceSurvey />
        </EventServiceProvider>
      </PageTitleProvider>
      <AdminOmnibox />
    </RoleTestingProvider>
  );
}

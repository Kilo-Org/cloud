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
          {/*
            The SSR-resolved user is seeded here so every consumer that renders
            during hydration (the sidebar footer and the customer-source survey)
            agrees with the server markup. Both live inside this boundary.
          */}
          <PrefetchedOrganizations>
            <SidebarProvider>
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
            </SidebarProvider>
            <CustomerSourceSurvey />
          </PrefetchedOrganizations>
        </EventServiceProvider>
      </PageTitleProvider>
      <AdminOmnibox />
    </RoleTestingProvider>
  );
}

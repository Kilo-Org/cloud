import { Suspense } from 'react';
import AppSidebar from './components/AppSidebar';
import { AppTopbar } from './components/AppTopbar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import { PageTitleProvider } from '@/contexts/PageTitleContext';
import { EventServiceProvider } from '@/contexts/EventServiceContext';
import { PersonalAccountProvider } from '@/contexts/PersonalAccountContext';
import { AdminOmnibox } from '@/components/admin-omnibox';
import { AppShellSkipLink } from '@/components/AppShellSkipLink';
import { PrefetchedOrganizations } from './components/PrefetchedOrganizations';
import { PlatformPresenceMount } from './components/PlatformPresenceMount';
import { getUserFromAuth } from '@/lib/user/server';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = (await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true }))
    ?.user;
  const personalAccountDisabled = user?.personal_account_disabled ?? false;

  return (
    <PersonalAccountProvider personalAccountDisabled={personalAccountDisabled}>
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
          </EventServiceProvider>
        </PageTitleProvider>
        <AdminOmnibox />
      </RoleTestingProvider>
    </PersonalAccountProvider>
  );
}

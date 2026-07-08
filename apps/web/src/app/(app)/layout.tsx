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
import { getUserFromAuth, getProfileRedirectPath } from '@/lib/user/server';
import { isRestrictedPersonalPath } from '@/lib/personal-account';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = (await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true }))
    ?.user;
  const personalAccountDisabled = user?.personal_account_disabled ?? false;

  // Block direct access to personal surfaces for personal-account-disabled
  // users. The switcher hiding and default sign-in redirect are not enough on
  // their own — a user could otherwise reach e.g. /profile by typing the URL or
  // via a validated callbackPath. Enforce it at the layout boundary.
  if (user && personalAccountDisabled) {
    const pathname = (await headers()).get('x-pathname') ?? '';
    if (pathname && isRestrictedPersonalPath(pathname)) {
      redirect(await getProfileRedirectPath(user));
    }
  }

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

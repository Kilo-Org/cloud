import { AnimatedLogo } from '@/components/AnimatedLogo';
import AppSidebar from './components/AppSidebar';
import { SidebarProvider, SidebarTrigger, SidebarInset } from '@/components/ui/sidebar';
import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import { AdminOmnibox } from '@/components/admin-omnibox';
import { PrefetchedOrganizations } from './components/PrefetchedOrganizations';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleTestingProvider>
      <SidebarProvider>
        <PrefetchedOrganizations>
          <div className="flex min-h-screen w-full">
            <AppSidebar />
            <SidebarInset>
              {/* Mobile header with sidebar trigger */}
              <header className="bg-background sticky top-0 z-10 flex h-18 items-center justify-between gap-4 border-b p-4 md:hidden">
                <AnimatedLogo />
                <SidebarTrigger />
              </header>
              {/* Main content */}
              <main className="bg-background w-full flex-1">{children}</main>
            </SidebarInset>
          </div>
        </PrefetchedOrganizations>
      </SidebarProvider>
      <AdminOmnibox />
    </RoleTestingProvider>
  );
}

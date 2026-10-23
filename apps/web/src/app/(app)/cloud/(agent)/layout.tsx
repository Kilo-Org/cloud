import { Suspense } from 'react';
import { CloudAgentProvider } from '@/components/cloud-agent-next/CloudAgentProvider';
import { CloudSidebarLayout } from '@/components/cloud-agent-next/CloudSidebarLayout';
import { PrefetchedCloudSidebar } from '@/components/cloud-agent-next/server/PrefetchedCloudSidebar';
import { readSidebarPreferences } from '@/components/cloud-agent-next/server/read-sidebar-preferences';
import { sidebarUpdatedSince } from '@/components/cloud-agent-next/hooks/sidebar-queries';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';

export default async function CloudAgentLayout({ children }: { children: React.ReactNode }) {
  const user = await getUserFromAuthOrRedirect();
  const updatedSince = sidebarUpdatedSince(new Date());
  const preferences = await readSidebarPreferences(user.id);

  return (
    <CloudAgentProvider>
      <PrefetchedCloudSidebar
        userId={user.id}
        organizationId={null}
        updatedSince={updatedSince}
        preferences={preferences}
      >
        {/* Empty, not a loading message: the page streams in complete. */}
        <Suspense fallback={<div className="h-[calc(100dvh-3.5rem)] w-full" />}>
          <CloudSidebarLayout
            currentUserId={user.id}
            sidebarUpdatedSince={updatedSince}
            sidebarPreferences={preferences}
          >
            {children}
          </CloudSidebarLayout>
        </Suspense>
      </PrefetchedCloudSidebar>
    </CloudAgentProvider>
  );
}

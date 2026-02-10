/**
 * App Builder Page
 *
 * Main page component that routes between:
 * - Landing page (no projectId): Create new projects
 * - Project view (with projectId): ProjectLoader -> ProjectSession -> AppBuilderProjectView
 *
 * - ProjectLoader: Handles async loading with tRPC/React Query
 * - ProjectSession: Manages ProjectManager lifecycle and provides context
 * - useProject/useProjectManager/useProjectState: Hooks for child components
 */

'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { ProjectLoader } from './ProjectLoader';
import { ProjectSession } from './ProjectSession';
import { AppBuilderChat } from './AppBuilderChat';
import { AppBuilderPreview } from './AppBuilderPreview';
import { AppBuilderLanding } from './AppBuilderLanding';

type AppBuilderPageProps = {
  organizationId?: string; // undefined for personal context
  projectId?: string; // undefined for new project
};

/**
 * Inner component that contains the chat and preview layout.
 * Rendered inside ProjectSession, so it has access to useProject hooks.
 */
function AppBuilderProjectView({ organizationId }: { organizationId?: string }) {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden lg:flex-row">
      {/* Chat Pane - 1/3 width on desktop, full width on mobile */}
      <div className="flex h-1/2 w-full flex-col overflow-hidden border-b lg:h-full lg:w-1/3 lg:border-r lg:border-b-0">
        <AppBuilderChat organizationId={organizationId} />
      </div>

      {/* Preview Pane - 2/3 width on desktop, full width on mobile */}
      <div className="flex h-1/2 w-full flex-col lg:h-full lg:w-2/3">
        <AppBuilderPreview organizationId={organizationId} />
      </div>
    </div>
  );
}

export function AppBuilderPage({ organizationId, projectId }: AppBuilderPageProps) {
  const router = useRouter();

  // Handle project creation from landing page
  const handleProjectCreated = useCallback(
    (createdProjectId: string, _prompt: string) => {
      // Navigate to the project page - ProjectLoader will handle loading
      const newPath = organizationId
        ? `/organizations/${organizationId}/app-builder/${createdProjectId}`
        : `/app-builder/${createdProjectId}`;
      router.replace(newPath);
    },
    [organizationId, router]
  );

  // Show landing if no projectId
  if (!projectId) {
    return (
      <AppBuilderLanding organizationId={organizationId} onProjectCreated={handleProjectCreated} />
    );
  }

  // Show project
  return (
    <ProjectLoader projectId={projectId} organizationId={organizationId ?? null}>
      {projectWithMessages => (
        <ProjectSession project={projectWithMessages} organizationId={organizationId ?? null}>
          <AppBuilderProjectView organizationId={organizationId} />
        </ProjectSession>
      )}
    </ProjectLoader>
  );
}

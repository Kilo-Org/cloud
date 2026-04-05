/**
 * ProjectLoader
 *
 * React component that handles async project loading using tRPC/React Query.
 * Shows loading, error, and success states, calling a render prop when loaded.
 *
 * Uses the appropriate tRPC router based on context:
 * - Personal: trpc.appBuilder.getProject
 * - Organization: trpc.organizations.appBuilder.getProject
 */

'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2Icon, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/utils';
import type { ProjectWithMessages } from '@/lib/app-builder/types';

type ProjectLoaderProps = {
  projectId: string;
  organizationId: string | null;
  children: (project: ProjectWithMessages) => React.ReactNode;
};

function LoadingSpinner() {
  return (
    <div
      className="flex h-[calc(100dvh-3.5rem)] w-full flex-col items-center justify-center gap-4"
      role="status"
      aria-busy="true"
    >
      <Loader2Icon className="h-12 w-12 animate-spin text-blue-400" />
      <p className="text-muted-foreground text-sm">Loading project...</p>
    </div>
  );
}

type ErrorCardProps = {
  message: string;
  onRetry: () => void;
  isRetrying: boolean;
};

function ErrorCard({ message, onRetry, isRetrying }: ErrorCardProps) {
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] w-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-destructive h-5 w-5" />
            <CardTitle>Failed to load project</CardTitle>
          </div>
          <CardDescription>
            {message || 'An unexpected error occurred while loading the project.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onRetry} disabled={isRetrying} className="w-full">
            {isRetrying ? (
              <>
                <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                Retrying...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function NotFoundCard() {
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] w-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-muted-foreground h-5 w-5" />
            <CardTitle>Project not found</CardTitle>
          </div>
          <CardDescription>
            This project may have been deleted or you may not have permission to view it.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

export function ProjectLoader({ projectId, organizationId, children }: ProjectLoaderProps) {
  const trpc = useTRPC();

  // Use the appropriate query based on context (personal vs organization)
  const queryOptions = organizationId
    ? trpc.organizations.appBuilder.getProject.queryOptions({
        projectId,
        organizationId,
      })
    : trpc.appBuilder.getProject.queryOptions({ projectId });

  const { data: project, error, isPending, isError, refetch, isFetching } = useQuery(queryOptions);

  // Loading state
  if (isPending) {
    return <LoadingSpinner />;
  }

  // Error state
  if (isError) {
    return (
      <ErrorCard message={error.message} onRetry={() => void refetch()} isRetrying={isFetching} />
    );
  }

  // Not found state (project is null/undefined)
  if (!project) {
    return <NotFoundCard />;
  }

  // Success - render children with the loaded project
  return <>{children(project)}</>;
}

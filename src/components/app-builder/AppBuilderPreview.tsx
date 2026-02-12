/**
 * App Builder Preview
 *
 * Preview pane component with iframe.
 * Uses ProjectSession context hooks for state and actions.
 * Shows different states: idle, building, running, error.
 */

'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import Link from 'next/link';
import {
  Loader2,
  RefreshCw,
  Maximize2,
  Minimize2,
  ExternalLink,
  AlertCircle,
  Rocket,
  Home,
  Copy,
  Check,
  Github,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { DEPLOYMENT_POLL_INTERVAL_MS } from '@/lib/user-deployments/constants';
import { isDeploymentInProgress, type BuildStatus } from '@/lib/user-deployments/types';
import { CloneDialog } from './CloneDialog';
import { MigrateToGitHubDialog } from './MigrateToGitHubDialog';
import { useProject } from './ProjectSession';
import { toast } from 'sonner';

type AppBuilderPreviewProps = {
  organizationId?: string;
};

function IdleState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="bg-muted mb-4 rounded-full p-6">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
      <h3 className="text-lg font-medium">Waiting for build environment</h3>
      <p className="text-muted-foreground mt-2 max-w-sm text-sm">
        Setting up the environment for your live preview...
      </p>
    </div>
  );
}

function BuildingState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="bg-muted mb-4 rounded-full p-6">
        <Loader2 className="text-primary h-8 w-8 animate-spin" />
      </div>
      <h3 className="text-lg font-medium">Starting live preview</h3>
      <p className="text-muted-foreground mt-2 max-w-sm text-sm">
        Your app is being built. This usually takes a few moments...
      </p>
      <div className="mt-4 flex items-center gap-2">
        <div className="bg-primary h-2 w-2 animate-pulse rounded-full" />
        <div className="bg-primary h-2 w-2 animate-pulse rounded-full [animation-delay:0.2s]" />
        <div className="bg-primary h-2 w-2 animate-pulse rounded-full [animation-delay:0.4s]" />
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 rounded-full bg-red-500/10 p-6">
        <AlertCircle className="h-8 w-8 text-red-500" />
      </div>
      <h3 className="text-lg font-medium">Preview Failed</h3>
      <p className="text-muted-foreground mt-2 max-w-sm text-sm">
        Something went wrong while building the preview. Please try again or check the chat for
        error details.
      </p>
      {onRetry && (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * Loading overlay shown while iframe content is loading
 */
function IframeLoadingOverlay() {
  return (
    <div className="bg-background/80 absolute inset-0 z-10 flex flex-col items-center justify-center backdrop-blur-sm">
      <div className="bg-muted mb-4 rounded-full p-6">
        <Loader2 className="text-primary h-8 w-8 animate-spin" />
      </div>
      <h3 className="text-lg font-medium">Loading preview</h3>
      <p className="text-muted-foreground mt-2 max-w-sm text-center text-sm">
        Starting your app... This may take a moment on first load.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <div className="bg-primary h-2 w-2 animate-pulse rounded-full" />
        <div className="bg-primary h-2 w-2 animate-pulse rounded-full [animation-delay:0.2s]" />
        <div className="bg-primary h-2 w-2 animate-pulse rounded-full [animation-delay:0.4s]" />
      </div>
    </div>
  );
}

type PreviewFrameProps = {
  url: string;
  currentPath: string;
  isAtRoot: boolean;
  isFullscreen: boolean;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onRefresh: () => void;
  onGoHome: () => void;
  onCopyUrl: () => Promise<boolean>;
  onToggleFullscreen: () => void;
  onOpenExternal: () => void;
};

/**
 * Preview frame controls bar
 */
function PreviewControls({
  currentPath,
  isAtRoot,
  isFullscreen,
  onRefresh,
  onGoHome,
  onCopyUrl,
  onToggleFullscreen,
  onOpenExternal,
}: Omit<PreviewFrameProps, 'url' | 'iframeRef'>) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear timeout on unmount to prevent setState on unmounted component
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const success = await onCopyUrl();
    if (success) {
      setCopied(true);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
    }
  }, [onCopyUrl]);

  return (
    <div className="flex items-center justify-between gap-4 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onGoHome} disabled={isAtRoot} title="Go to home">
          <Home className="h-4 w-4" />
        </Button>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{currentPath}</span>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={handleCopy} title="Copy URL">
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={onRefresh} title="Refresh preview">
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenExternal} title="Open in new tab">
          <ExternalLink className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * Preview iframe with controls - renders dev or production iframe based on environment
 */
function PreviewFrame(props: PreviewFrameProps) {
  const {
    url,
    currentPath,
    isAtRoot,
    isFullscreen,
    iframeRef,
    onRefresh,
    onGoHome,
    onCopyUrl,
    onToggleFullscreen,
    onOpenExternal,
  } = props;
  const [isIframeLoading, setIsIframeLoading] = useState(true);

  // Reset loading state when URL changes
  useEffect(() => {
    setIsIframeLoading(true);
  }, [url]);

  const handleIframeLoad = useCallback(() => {
    setIsIframeLoading(false);
  }, []);

  return (
    <div className={cn('flex h-full flex-col', isFullscreen && 'bg-background fixed inset-0 z-50')}>
      <PreviewControls
        currentPath={currentPath}
        isAtRoot={isAtRoot}
        isFullscreen={isFullscreen}
        onRefresh={onRefresh}
        onGoHome={onGoHome}
        onCopyUrl={onCopyUrl}
        onToggleFullscreen={onToggleFullscreen}
        onOpenExternal={onOpenExternal}
      />
      <div className="relative flex-1">
        {isIframeLoading && <IframeLoadingOverlay />}
        <iframe
          ref={iframeRef}
          src={url}
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          title="App Preview"
          onLoad={handleIframeLoad}
        />
      </div>
    </div>
  );
}

type DeploymentState =
  | { kind: 'creating' }
  | { kind: 'in-progress'; buildStatus: BuildStatus; deploymentId: string }
  | { kind: 'deployed'; deploymentUrl: string; deploymentId: string }
  | { kind: 'failed'; deploymentId: string }
  | { kind: 'ready-to-deploy' }
  | { kind: 'hidden' };

function getDeploymentState({
  isCreatingDeployment,
  deploymentId,
  buildStatus,
  deploymentUrl,
  previewStatus,
}: {
  isCreatingDeployment: boolean;
  deploymentId: string | null;
  buildStatus?: BuildStatus;
  deploymentUrl?: string | null;
  previewStatus: string;
}): DeploymentState {
  if (!deploymentId) {
    if (isCreatingDeployment) return { kind: 'creating' };

    if (previewStatus === 'running') {
      return { kind: 'ready-to-deploy' };
    }
  } else {
    // buildStatus not yet loaded - show as in-progress while waiting for query
    if (!buildStatus) {
      return { kind: 'in-progress', buildStatus: 'queued', deploymentId };
    }
    if (isDeploymentInProgress(buildStatus)) {
      return { kind: 'in-progress', buildStatus, deploymentId };
    }
    if (buildStatus === 'deployed' && deploymentUrl) {
      return { kind: 'deployed', deploymentUrl, deploymentId };
    }
    if (buildStatus === 'failed') {
      return { kind: 'failed', deploymentId };
    }
  }

  return { kind: 'hidden' };
}

const statusLabels: Record<BuildStatus, string> = {
  queued: 'Queued',
  building: 'Building',
  deploying: 'Deploying',
  deployed: 'Deployed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function deploymentPageUrl(organizationId: string | undefined, deploymentId: string) {
  const base = organizationId ? `/organizations/${organizationId}/deploy` : '/deploy';
  return `${base}/${deploymentId}`;
}

function DeploymentControls({
  state,
  onDeploy,
  organizationId,
}: {
  state: DeploymentState;
  onDeploy: () => void;
  organizationId?: string;
}) {
  switch (state.kind) {
    case 'creating':
      return (
        <Button size="sm" variant="outline" disabled>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Creating...
        </Button>
      );
    case 'in-progress':
      return (
        <Button size="sm" variant="outline" asChild>
          <Link href={deploymentPageUrl(organizationId, state.deploymentId)} target="_blank">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {statusLabels[state.buildStatus]}...
          </Link>
        </Button>
      );
    case 'deployed':
      return (
        <Button size="sm" variant="outline" asChild>
          <a href={state.deploymentUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-2 h-4 w-4" />
            View Site
          </a>
        </Button>
      );
    case 'failed':
      return (
        <Button size="sm" variant="outline" className="text-red-400" asChild>
          <Link href={deploymentPageUrl(organizationId, state.deploymentId)} target="_blank">
            <AlertCircle className="mr-2 h-4 w-4" />
            Failed - View Logs
          </Link>
        </Button>
      );
    case 'ready-to-deploy':
      return (
        <Button
          size="sm"
          variant="outline"
          onClick={onDeploy}
          className="border-yellow-500/50 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20"
        >
          <Rocket className="mr-2 h-4 w-4" />
          Deploy
        </Button>
      );
    case 'hidden':
      return null;
  }
}

/** Extract pathname from URL, stripping query params */
function getPathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

/**
 * Main preview component
 */
export const AppBuilderPreview = memo(function AppBuilderPreview({
  organizationId,
}: AppBuilderPreviewProps) {
  // Get state and manager from ProjectSession context
  const { manager, state } = useProject();
  const { previewUrl, previewStatus, deploymentId, currentIframeUrl, gitRepoFullName } = state;
  const projectId = manager.projectId;
  const isMigrated = Boolean(gitRepoFullName);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [isCreatingDeployment, setIsCreatingDeployment] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Derive current path from tracked URL or fall back to previewUrl
  const currentPath = currentIframeUrl
    ? getPathFromUrl(currentIframeUrl)
    : previewUrl
      ? getPathFromUrl(previewUrl)
      : '/';
  const isAtRoot = currentPath === '/';

  // Listen for postMessage navigation events from the preview iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Validate origin: only accept messages from the preview iframe's origin
      // and verify the message comes from the iframe's content window
      if (!previewUrl) return;
      let previewOrigin: string;
      try {
        previewOrigin = new URL(previewUrl).origin;
      } catch {
        return;
      }
      if (event.origin !== previewOrigin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;

      if (event.data?.type === 'kilo-preview-navigation') {
        // Validate that the reported URL's origin matches the preview origin
        // to prevent a compromised app from injecting arbitrary external URLs
        try {
          const reportedUrl = event.data.url;
          if (typeof reportedUrl === 'string' && new URL(reportedUrl).origin === previewOrigin) {
            manager.setCurrentIframeUrl(reportedUrl);
          }
        } catch {
          // Invalid URL, ignore
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [manager, previewUrl]);

  // Reset currentIframeUrl when previewUrl changes
  useEffect(() => {
    manager.setCurrentIframeUrl(null);
  }, [previewUrl, manager]);

  // Get tRPC for queries
  const trpc = useTRPC();

  // Poll deployment status when we have a deploymentId
  // Use org-specific or personal query based on context
  const personalDeploymentQuery = useQuery({
    ...trpc.deployments.getDeployment.queryOptions({ id: deploymentId ?? '' }),
    enabled: !!deploymentId && !organizationId,
    refetchInterval: query => {
      const status = query.state.data?.latestBuild?.status;
      return isDeploymentInProgress(status) ? DEPLOYMENT_POLL_INTERVAL_MS : false;
    },
  });
  const orgDeploymentQuery = useQuery({
    ...trpc.organizations.deployments.getDeployment.queryOptions({
      id: deploymentId ?? '',
      organizationId: organizationId ?? '',
    }),
    enabled: !!deploymentId && !!organizationId,
    refetchInterval: query => {
      const status = query.state.data?.latestBuild?.status;
      return isDeploymentInProgress(status) ? DEPLOYMENT_POLL_INTERVAL_MS : false;
    },
  });
  const deploymentData = organizationId ? orgDeploymentQuery.data : personalDeploymentQuery.data;

  const buildStatus = deploymentData?.latestBuild?.status;
  const deploymentUrl = deploymentData?.deployment?.deployment_url;

  // Periodic ping to keep sandbox alive (pauses when tab is hidden)
  useEffect(() => {
    if (previewStatus !== 'running' || !previewUrl) return;

    const ping = () => void fetch(previewUrl, { method: 'HEAD' }).catch(() => {});

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (!intervalId) {
          ping();
          intervalId = setInterval(ping, 20000);
        }
      } else if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    handleVisibilityChange();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [previewUrl, previewStatus]);

  const handleRefresh = useCallback(() => {
    manager.setCurrentIframeUrl(null);
    setIframeKey(prev => prev + 1);
  }, [manager]);

  const handleToggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
  }, []);

  const handleOpenExternal = useCallback(() => {
    const urlToOpen = currentIframeUrl || previewUrl;
    if (urlToOpen) {
      window.open(urlToOpen, '_blank', 'noopener,noreferrer');
    }
  }, [currentIframeUrl, previewUrl]);

  const handleGoHome = useCallback(() => {
    if (previewUrl && iframeRef.current?.contentWindow) {
      try {
        const baseUrl = new URL(previewUrl);
        baseUrl.pathname = '/';
        baseUrl.search = '';
        iframeRef.current.contentWindow.postMessage(
          { type: 'kilo-preview-navigate', url: baseUrl.toString() },
          baseUrl.origin
        );
      } catch {
        // Invalid previewUrl, ignore
      }
    }
  }, [previewUrl]);

  const handleCopyUrl = useCallback(async (): Promise<boolean> => {
    const urlToCopy = currentIframeUrl || previewUrl;
    if (urlToCopy) {
      try {
        await navigator.clipboard.writeText(urlToCopy);
        return true;
      } catch {
        toast.error('Failed to copy URL to clipboard');
        return false;
      }
    }
    return false;
  }, [currentIframeUrl, previewUrl]);

  // Handle deploy using ProjectManager
  const handleDeploy = useCallback(async () => {
    setIsCreatingDeployment(true);
    try {
      const result = await manager.deploy();
      if (!result.success && result.error === 'payment_required') {
        toast('Payment required to create deployments.', {
          description: 'Visit the billing page to add a payment method.',
        });
      }
    } catch (error) {
      console.error('Deployment failed:', error);
    } finally {
      setIsCreatingDeployment(false);
    }
  }, [manager]);

  const deploymentState = getDeploymentState({
    isCreatingDeployment,
    deploymentId,
    buildStatus,
    deploymentUrl,
    previewStatus,
  });

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center justify-between gap-4 border-b px-4">
        <h2 className="shrink-0 text-sm font-medium">Preview</h2>

        <div className="flex items-center gap-2">
          {projectId && !isMigrated && (
            <>
              <MigrateToGitHubDialog
                projectId={projectId}
                organizationId={organizationId}
                onMigrationComplete={repoFullName => manager.setGitRepoFullName(repoFullName)}
              />
              <CloneDialog projectId={projectId} organizationId={organizationId} />
            </>
          )}
          {isMigrated && gitRepoFullName && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={`https://github.com/${gitRepoFullName}`}
                target="_blank"
                rel="noopener noreferrer"
                title={gitRepoFullName}
              >
                <Github className="mr-2 h-4 w-4" />
                GitHub
                <ExternalLink className="ml-1.5 h-3 w-3 opacity-50" />
              </a>
            </Button>
          )}
          <DeploymentControls
            state={deploymentState}
            onDeploy={handleDeploy}
            organizationId={organizationId}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1">
        {previewStatus === 'idle' && <IdleState />}
        {previewStatus === 'building' && <BuildingState />}
        {previewStatus === 'error' && <ErrorState />}
        {previewStatus === 'running' && !previewUrl && <ErrorState />}
        {previewStatus === 'running' && previewUrl && (
          <PreviewFrame
            key={iframeKey}
            url={previewUrl}
            currentPath={currentPath}
            isAtRoot={isAtRoot}
            isFullscreen={isFullscreen}
            iframeRef={iframeRef}
            onRefresh={handleRefresh}
            onGoHome={handleGoHome}
            onCopyUrl={handleCopyUrl}
            onToggleFullscreen={handleToggleFullscreen}
            onOpenExternal={handleOpenExternal}
          />
        )}
      </div>
    </div>
  );
});

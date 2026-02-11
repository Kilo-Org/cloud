'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDeploymentQueries } from '@/components/deployments/DeploymentContext';
import { StatusBadge } from './StatusBadge';
import { BuildLogViewer } from './BuildLogViewer';
import { EnvironmentSettings } from './EnvironmentSettings';
import { PasswordSettings } from './PasswordSettings';
import { SlugEditor } from './SlugEditor';
import { Button } from '@/components/Button';
import { Loader2, AlertCircle, Trash2, RotateCw, XCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { isDeploymentFinished, isDeploymentInProgress } from '@/lib/user-deployments/types';
import { toast } from 'sonner';

type DeploymentDetailsProps = {
  deploymentId: string;
  isOpen: boolean;
  onClose: () => void;
};

export function DeploymentDetails({ deploymentId, isOpen, onClose }: DeploymentDetailsProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'environment' | 'password'>('overview');
  const { queries, mutations } = useDeploymentQueries();

  // Check if password features are available (org-only)
  const hasPasswordFeature = !!mutations.setPassword;

  const redeployMutation = mutations.redeploy;
  const deleteDeploymentMutation = mutations.deleteDeployment;
  const cancelBuildMutation = mutations.cancelBuild;

  const {
    data: deploymentData,
    isLoading: isLoadingDeployment,
    error: deploymentError,
    refetch: refetchDeployment,
  } = queries.getDeployment(deploymentId);

  const deployment = deploymentData?.deployment;
  const latestBuild = deploymentData?.latestBuild;
  const deploymentStatus = latestBuild?.status || 'queued';
  const showActionButtons = isDeploymentFinished(deploymentStatus);
  const showCancelButton = latestBuild && isDeploymentInProgress(deploymentStatus);

  const handleRedeploy = () => {
    redeployMutation.mutate(
      { id: deploymentId },
      {
        onSuccess: () => {
          toast.success('Deployment queued for redeployment');
        },
        onError: error => {
          toast.error(`Failed to redeploy: ${error.message}`);
        },
      }
    );
  };

  const handleCancel = () => {
    if (!latestBuild) return;

    if (window.confirm('Are you sure you want to cancel this build?')) {
      cancelBuildMutation.mutate(
        { deploymentId, buildId: latestBuild.id },
        {
          onSuccess: () => {
            toast.success('Build cancelled successfully');
          },
          onError: error => {
            toast.error(`Failed to cancel build: ${error.message}`);
          },
        }
      );
    }
  };

  const handleDelete = () => {
    if (
      window.confirm(
        'Are you sure you want to delete this deployment? This action cannot be undone.'
      )
    ) {
      deleteDeploymentMutation.mutate(
        { id: deploymentId },
        {
          onSuccess: () => {
            toast.success('Deployment deleted successfully');
            onClose();
          },
          onError: error => {
            toast.error(`Failed to delete deployment: ${error.message}`);
          },
        }
      );
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Deployment Details</DialogTitle>
        </DialogHeader>

        {isLoadingDeployment ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-8 animate-spin text-gray-400" />
          </div>
        ) : deploymentError ? (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="flex items-center gap-2 text-red-400">
              <AlertCircle className="size-6" />
              <div>
                <p className="font-semibold">Failed to load deployment</p>
                <p className="text-sm text-gray-400">
                  {deploymentError.data?.code === 'NOT_FOUND'
                    ? 'Deployment not found. It may have been deleted.'
                    : deploymentError.message}
                </p>
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={() => refetchDeployment()}>
              Retry
            </Button>
          </div>
        ) : deployment ? (
          <Tabs
            value={activeTab}
            onValueChange={value => setActiveTab(value as 'overview' | 'environment' | 'password')}
          >
            <TabsList
              className={`grid w-full ${hasPasswordFeature ? 'grid-cols-3' : 'grid-cols-2'}`}
            >
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="environment">Environment</TabsTrigger>
              {hasPasswordFeature && <TabsTrigger value="password">Password</TabsTrigger>}
            </TabsList>

            <TabsContent value="overview" className="space-y-6">
              <div className="space-y-4 pt-2">
                <div className="flex items-center justify-between gap-3">
                  <SlugEditor
                    deploymentId={deploymentId}
                    currentSlug={deployment.deployment_slug}
                    deploymentUrl={deployment.deployment_url}
                  />
                  <StatusBadge status={deploymentStatus} className="shrink-0" />
                </div>

                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <span className="text-gray-400">Repository</span>
                  <span className="truncate text-gray-100" title={deployment.repository_source}>
                    {deployment.repository_source}
                  </span>
                  <span className="text-gray-400">Branch</span>
                  <span className="text-gray-100">{deployment.branch}</span>
                  {deployment.last_deployed_at && (
                    <>
                      <span className="text-gray-400">Deployed</span>
                      <span className="text-gray-100">
                        {formatDistanceToNow(new Date(deployment.last_deployed_at), {
                          addSuffix: true,
                        })}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="border-t border-gray-700 pt-6">
                <h3 className="mb-4 text-lg font-semibold text-gray-100">Last Build</h3>

                {!latestBuild ? (
                  <div className="flex flex-col items-center gap-2 py-8">
                    <p className="text-center text-gray-500">No builds yet</p>
                    <p className="text-center text-sm text-gray-600">
                      Trigger a deployment to see build details
                    </p>
                  </div>
                ) : (
                  <BuildLogViewer
                    deploymentId={deploymentId}
                    buildId={latestBuild.id}
                    status={latestBuild.status}
                  />
                )}
              </div>

              {showCancelButton && (
                <div className="border-t border-gray-700 pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-100">Cancel Build</h3>
                      <p className="mt-1 text-sm text-gray-400">Stop the current build process.</p>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={handleCancel}
                      disabled={cancelBuildMutation.isPending}
                      className="gap-1.5"
                      aria-label="Cancel build"
                    >
                      {cancelBuildMutation.isPending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Cancelling...
                        </>
                      ) : (
                        <>
                          <XCircle className="size-4" />
                          Cancel Build
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {showActionButtons && (
                <div className="border-t border-gray-700 pt-6">
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-100">Redeploy</h3>
                        <p className="mt-1 text-sm text-gray-400">
                          Trigger a new deployment with the latest code from the repository
                        </p>
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleRedeploy}
                        disabled={redeployMutation.isPending}
                        className="gap-1.5"
                        aria-label="Redeploy"
                      >
                        {redeployMutation.isPending ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            Redeploying...
                          </>
                        ) : (
                          <>
                            <RotateCw className="size-4" />
                            Redeploy
                          </>
                        )}
                      </Button>
                    </div>

                    <div className="flex items-center justify-between border-t border-gray-700 pt-6">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-100">Danger Zone</h3>
                        <p className="mt-1 text-sm text-gray-400">
                          Permanently delete this deployment and all its builds
                        </p>
                      </div>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={handleDelete}
                        disabled={deleteDeploymentMutation.isPending}
                        className="gap-1.5"
                        aria-label="Delete deployment"
                      >
                        {deleteDeploymentMutation.isPending ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            Deleting...
                          </>
                        ) : (
                          <>
                            <Trash2 className="size-4" />
                            Delete Deployment
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="environment" className="space-y-6">
              <EnvironmentSettings deploymentId={deploymentId} />
            </TabsContent>

            {hasPasswordFeature && (
              <TabsContent value="password" className="space-y-6">
                <PasswordSettings deploymentId={deploymentId} />
              </TabsContent>
            )}
          </Tabs>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

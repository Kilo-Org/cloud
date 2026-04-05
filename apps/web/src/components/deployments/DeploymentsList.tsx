'use client';

import { DeploymentCard } from './DeploymentCard';
import { Loader2, AlertCircle, Rocket } from 'lucide-react';
import { Button } from '@/components/Button';
import { useDeploymentQueries } from './DeploymentContext';

type DeploymentsListProps = {
  onViewDetails: (deploymentId: string) => void;
};

export function DeploymentsList({ onViewDetails }: DeploymentsListProps) {
  const { queries } = useDeploymentQueries();
  const { data: deploymentsData, isLoading, error, refetch } = queries.listDeployments();

  const handleViewDetails = (deploymentId: string) => {
    onViewDetails(deploymentId);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-gray-400">
          <Loader2 className="size-6 animate-spin" />
          <span>Loading deployments...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <div className="flex items-center gap-2 text-red-400">
          <AlertCircle className="size-6" />
          <div>
            <p className="font-semibold">Failed to load deployments</p>
            <p className="text-sm text-gray-400">{error.message}</p>
          </div>
        </div>
        <Button variant="primary" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const deployments = deploymentsData?.data || [];

  if (deployments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-16">
        <Rocket className="mb-4 size-16 text-gray-600" />
        <h3 className="mb-2 text-xl font-semibold text-gray-300">No deployments yet</h3>
        <p className="text-center text-gray-500">Create your first deployment to get started.</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {deployments.map(item => (
          <DeploymentCard
            key={item.deployment.id}
            deployment={item.deployment}
            latestBuild={item.latestBuild}
            onViewDetails={() => handleViewDetails(item.deployment.id)}
          />
        ))}
      </div>
    </>
  );
}

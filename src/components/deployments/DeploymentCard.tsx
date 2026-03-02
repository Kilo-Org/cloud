'use client';

import type { Deployment, DeploymentBuild } from '@kilocode/db/schema';
import { StatusBadge } from './StatusBadge';
import { GitBranch, ExternalLink } from 'lucide-react';
import { isDeploymentCompleted } from '@/lib/user-deployments/types';

type DeploymentCardProps = {
  deployment: Deployment;
  latestBuild: DeploymentBuild | null;
  onViewDetails: () => void;
};

export function DeploymentCard({ deployment, latestBuild, onViewDetails }: DeploymentCardProps) {
  const status = latestBuild?.status || 'queued';

  return (
    <div
      className="relative flex h-full cursor-pointer flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-900/50 p-6 transition-all hover:border-gray-600 hover:bg-gray-900/70"
      onClick={onViewDetails}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onViewDetails();
        }
      }}
      aria-label={`View details for ${deployment.deployment_slug}`}
    >
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-lg font-semibold text-gray-100">
              {deployment.deployment_slug}
            </h3>
            {isDeploymentCompleted(status) ? (
              <a
                href={deployment.deployment_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 flex w-fit items-center gap-1 text-sm whitespace-nowrap text-blue-400 hover:text-blue-300"
                onClick={e => e.stopPropagation()}
              >
                {deployment.deployment_slug}.d.kiloapps.io
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="mt-1 flex w-fit items-center gap-1 text-sm text-gray-500">
                {deployment.deployment_slug}.d.kiloapps.io
              </span>
            )}
          </div>
          <StatusBadge status={status} />
        </div>

        <div className="flex flex-col gap-2 text-sm text-gray-400">
          <div className="flex items-center gap-2">
            <span className="truncate">{deployment.repository_source}</span>
          </div>
          <div className="flex items-center gap-2">
            <GitBranch className="size-4" />
            <span className="truncate">{deployment.branch}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { Loader2, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { useDeploymentQueries } from './DeploymentContext';
import type { DeploymentQueries, DeploymentMutations } from '@/lib/user-deployments/router-types';

type BannerSettingsProps = {
  deploymentId: string;
};

type BannerSettingsContentProps = {
  deploymentId: string;
  getBannerStatusQuery: NonNullable<DeploymentQueries['getBannerStatus']>;
  setBannerMutation: NonNullable<DeploymentMutations['setBanner']>;
};

function BannerSettingsContent({
  deploymentId,
  getBannerStatusQuery,
  setBannerMutation,
}: BannerSettingsContentProps) {
  const { data: bannerStatus, isLoading, error } = getBannerStatusQuery(deploymentId);
  const isEnabled = bannerStatus?.enabled ?? false;

  const handleToggle = () => {
    const newEnabled = !isEnabled;
    setBannerMutation.mutate(
      { deploymentId, enabled: newEnabled },
      {
        onSuccess: () => {
          toast.success(newEnabled ? 'Banner enabled' : 'Banner disabled');
        },
        onError: err => {
          toast.error(`Failed to update banner: ${err.message}`);
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/50 bg-red-400/10 p-4">
        <p className="text-sm text-red-400">Failed to load banner status: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-100">
            Show &ldquo;Made with App Builder&rdquo; badge
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            Display a small badge on your deployed site linking to kilo.ai
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isEnabled}
          onClick={handleToggle}
          disabled={setBannerMutation.isPending}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-900 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
            isEnabled ? 'bg-blue-600' : 'bg-gray-600'
          }`}
        >
          <span
            className={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              isEnabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-4">
        <div className="flex items-center gap-3">
          {isEnabled ? (
            <Eye className="size-5 text-blue-400" />
          ) : (
            <EyeOff className="size-5 text-gray-500" />
          )}
          <p className="text-sm text-gray-400">
            {isEnabled
              ? 'The "Made with Kilo App Builder" badge is visible on your deployed site.'
              : 'The badge is hidden. Enable it to show a small "Made with Kilo App Builder" link on your deployed site.'}
          </p>
        </div>
      </div>
    </div>
  );
}

export function BannerSettings({ deploymentId }: BannerSettingsProps) {
  const { queries, mutations } = useDeploymentQueries();

  const getBannerStatusQuery = queries.getBannerStatus;
  const setBannerMutation = mutations.setBanner;

  if (!getBannerStatusQuery || !setBannerMutation) {
    return null;
  }

  return (
    <BannerSettingsContent
      deploymentId={deploymentId}
      getBannerStatusQuery={getBannerStatusQuery}
      setBannerMutation={setBannerMutation}
    />
  );
}

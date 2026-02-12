'use client';

import { useRouter } from 'next/navigation';
import { DeploymentsList } from '@/components/deployments/DeploymentsList';
import { DeploymentDetails } from '@/components/deployments/DeploymentDetails';
import { NewDeploymentDialog } from '@/components/deployments/NewDeploymentDialog';
import { OrgDeploymentProvider } from '@/components/deployments/OrgDeploymentProvider';
import { OrgGitHubAppsProvider } from '@/components/integrations/OrgGitHubAppsProvider';
import { Button } from '@/components/Button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Plus } from 'lucide-react';
import { useState } from 'react';

type DeployPageClientProps = {
  organizationId: string;
  initialDeploymentId?: string;
};

export function DeployPageClient({ organizationId, initialDeploymentId }: DeployPageClientProps) {
  const router = useRouter();
  const [isNewDeploymentOpen, setIsNewDeploymentOpen] = useState(false);

  const basePath = `/organizations/${organizationId}/deploy`;

  const handleViewDetails = (deploymentId: string) => {
    router.push(`${basePath}/${deploymentId}`);
  };

  const handleCloseDetails = () => {
    router.push(basePath);
  };

  const handleNewDeployment = () => {
    setIsNewDeploymentOpen(true);
  };

  const handleNewDeploymentSuccess = () => {
    setIsNewDeploymentOpen(false);
  };

  return (
    <OrgDeploymentProvider organizationId={organizationId}>
      <OrgGitHubAppsProvider organizationId={organizationId}>
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-bold text-gray-100">Deployments</h1>
                <Badge variant="new">new</Badge>
              </div>
              <p className="text-gray-400">Deploy your web project</p>
              <a
                href="https://kilo.ai/docs/advanced-usage/deploy"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
              >
                Learn how to use it
                <ExternalLink className="size-4" />
              </a>
            </div>
            <Button variant="primary" size="md" onClick={handleNewDeployment} className="gap-2">
              <Plus className="size-5" />
              New Deployment
            </Button>
          </div>
        </div>

        <DeploymentsList onViewDetails={handleViewDetails} />

        {initialDeploymentId && (
          <DeploymentDetails
            deploymentId={initialDeploymentId}
            isOpen={true}
            onClose={handleCloseDetails}
          />
        )}

        <NewDeploymentDialog
          isOpen={isNewDeploymentOpen}
          onClose={() => setIsNewDeploymentOpen(false)}
          onSuccess={handleNewDeploymentSuccess}
          organizationId={organizationId}
        />
      </OrgGitHubAppsProvider>
    </OrgDeploymentProvider>
  );
}

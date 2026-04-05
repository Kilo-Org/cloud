import type { BuildStatus } from '@/lib/user-deployments/types';

export type DeploymentSortableField = 'created_at' | 'deployment_slug' | 'repository_source';

export type DeploymentSortConfig = {
  field: DeploymentSortableField;
  direction: 'asc' | 'desc';
};

export type AdminDeploymentTableProps = {
  id: string;
  deployment_slug: string;
  repository_source: string;
  branch: string;
  deployment_url: string;
  source_type: 'github' | 'git' | 'app-builder';
  created_at: string;
  last_deployed_at: string | null;
  // Owner info - one of these will be populated
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  // Denormalized owner info for display
  owner_email: string | null;
  owner_org_name: string | null;
  // Created by user info (who triggered the deployment)
  created_by_user_id: string | null;
  created_by_user_email: string | null;
  // Latest build info
  latest_build_status: BuildStatus | null;
  latest_build_id: string | null;
};

export type AdminDeploymentBuild = {
  id: string;
  status: BuildStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type AdminDeploymentBuildsApiResponse = {
  builds: AdminDeploymentBuild[];
};

export type AdminDeploymentsApiResponse = {
  deployments: AdminDeploymentTableProps[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

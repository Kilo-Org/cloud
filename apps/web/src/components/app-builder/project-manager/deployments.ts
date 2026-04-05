/**
 * Deployment module for ProjectManager.
 * Handles deploying projects to production.
 */

import type { DeploymentConfig, DeployResult } from './types';

/**
 * Deploy a project to production.
 *
 * Calls the appropriate TRPC endpoint based on whether the project belongs
 * to an organization or a user, and updates the store with the deployment ID.
 *
 * @param config - Deployment configuration including project ID, org ID, TRPC client, and store
 * @returns The deployment result containing success status and deployment ID
 */
export async function deploy(config: DeploymentConfig): Promise<DeployResult> {
  const { projectId, organizationId, trpcClient, store } = config;

  const result = organizationId
    ? await trpcClient.organizations.appBuilder.deployProject.mutate({
        projectId,
        organizationId,
      })
    : await trpcClient.appBuilder.deployProject.mutate({
        projectId,
      });

  if (result.success) {
    store.setState({ deploymentId: result.deploymentId });
  }

  return result;
}

import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import type { Deployment, DeploymentBuild } from '@/db/schema';
import type { Event, BuildStatus } from './types';
import type { EnvVarResponse } from './env-vars-validation';
import type { GetPasswordStatusResponse } from './dispatcher-client';

/**
 * Result type for creating a deployment - discriminated union
 */
export type CreateDeploymentResult =
  | { success: true; deploymentId: string; deploymentSlug: string; deploymentUrl: string }
  | { success: false; error: 'payment_required' | 'invalid_slug' | 'slug_taken'; message: string };

/**
 * Represents an owner that can be either a user or an organization
 */
export type Owner = { type: 'user'; id: string } | { type: 'org'; id: string };

/**
 * Response type for listing deployments
 */
export type ListDeploymentsResponse = {
  success: boolean;
  data: Array<{
    deployment: Deployment;
    latestBuild: DeploymentBuild | null;
  }>;
};

/**
 * Response type for getting a single deployment
 */
export type GetDeploymentResponse = {
  success: boolean;
  deployment: Deployment;
  latestBuild: DeploymentBuild | null;
};

/**
 * Parameters for getBuildEvents query
 */
export type BuildEventsParams = {
  deploymentId: string;
  buildId: string;
  limit?: number;
  afterEventId?: number;
};

/**
 * Input for creating a deployment
 */
export type CreateDeploymentInput = {
  platformIntegrationId: string;
  repositoryFullName: string;
  branch: string;
  envVars?: Array<{
    key: string;
    value: string;
    isSecret: boolean;
  }>;
};

/**
 * TRPC error type for deployment operations
 * Using AnyRouter to avoid circular dependency with root-router.ts
 */
export type DeploymentError = TRPCClientErrorLike<AnyRouter>;

/**
 * Response type for checking deployment eligibility
 */
export type CheckDeploymentEligibilityResponse = {
  canCreateDeployment: boolean;
};

/**
 * Query interface that both user and org deployment providers must implement
 */
export type DeploymentQueries = {
  /**
   * Check if the owner is eligible to create deployments (requires payment)
   */
  checkDeploymentEligibility: () => UseQueryResult<
    CheckDeploymentEligibilityResponse,
    DeploymentError
  >;

  /**
   * List all deployments
   */
  listDeployments: () => UseQueryResult<ListDeploymentsResponse, DeploymentError>;

  /**
   * Get a single deployment by ID
   */
  getDeployment: (id: string) => UseQueryResult<GetDeploymentResponse, DeploymentError>;

  /**
   * Get build events for a specific build
   */
  getBuildEvents: (
    params: BuildEventsParams & { status: BuildStatus }
  ) => UseQueryResult<Event[], DeploymentError>;

  /**
   * List environment variables for a deployment
   */
  listEnvVars: (deploymentId: string) => UseQueryResult<EnvVarResponse[], DeploymentError>;

  /**
   * Get password protection status for a deployment (org-only)
   */
  getPasswordStatus?: (
    deploymentId: string
  ) => UseQueryResult<GetPasswordStatusResponse, DeploymentError>;
};

/**
 * Mutation interface that both user and org deployment providers must implement
 */
export type DeploymentMutations = {
  /**
   * Create a new deployment
   */
  createDeployment: UseMutationResult<
    CreateDeploymentResult,
    DeploymentError,
    CreateDeploymentInput
  >;

  /**
   * Delete a deployment
   */
  deleteDeployment: UseMutationResult<unknown, DeploymentError, { id: string }>;

  /**
   * Cancel a running build
   */
  cancelBuild: UseMutationResult<
    { success: boolean },
    DeploymentError,
    { deploymentId: string; buildId: string }
  >;

  /**
   * Redeploy an existing deployment
   */
  redeploy: UseMutationResult<unknown, DeploymentError, { id: string }>;

  /**
   * Set an environment variable
   */
  setEnvVar: UseMutationResult<
    unknown,
    DeploymentError,
    { deploymentId: string; key: string; value: string; isSecret: boolean }
  >;

  /**
   * Delete an environment variable
   */
  deleteEnvVar: UseMutationResult<unknown, DeploymentError, { deploymentId: string; key: string }>;

  /**
   * Rename an environment variable
   */
  renameEnvVar: UseMutationResult<
    unknown,
    DeploymentError,
    { deploymentId: string; oldKey: string; newKey: string }
  >;

  /**
   * Set password protection for a deployment (org-only)
   */
  setPassword?: UseMutationResult<
    { success: true; passwordSetAt: number },
    DeploymentError,
    { deploymentId: string; password: string }
  >;

  /**
   * Remove password protection from a deployment (org-only)
   */
  removePassword?: UseMutationResult<{ success: true }, DeploymentError, { deploymentId: string }>;
};

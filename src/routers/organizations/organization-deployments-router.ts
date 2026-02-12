import 'server-only';
import { createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import { organizationMemberProcedure } from './utils';
import { branchSchema, repoNameSchema, slugSchema } from '@/lib/user-deployments/validation';
import * as deploymentsService from '@/lib/user-deployments/deployments-service';
import * as envVarsService from '@/lib/user-deployments/env-vars-service';
import { dispatcherClient } from '@/lib/user-deployments/dispatcher-client';
import {
  envVarKeySchema,
  plaintextEnvVarSchema,
  baseEnvVarSchema,
  markAsPlaintext,
} from '@/lib/user-deployments/env-vars-validation';
import { hasOrganizationEverPaid } from '@/lib/creditTransactions';

export const organizationDeploymentsRouter = createTRPCRouter({
  checkDeploymentEligibility: organizationMemberProcedure.query(async ({ input }) => {
    const canCreateDeployment = await hasOrganizationEverPaid(input.organizationId);
    return { canCreateDeployment };
  }),

  listDeployments: organizationMemberProcedure.query(async ({ input }) => {
    return deploymentsService.listDeployments({
      type: 'org',
      id: input.organizationId,
    });
  }),

  getDeployment: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        id: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      return deploymentsService.getDeployment(input.id, {
        type: 'org',
        id: input.organizationId,
      });
    }),

  getBuildEvents: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
        buildId: z.string().uuid(),
        limit: z.number().min(1).max(1000).optional().default(100),
        afterEventId: z.number().optional(),
      })
    )
    .query(async ({ input }) => {
      return deploymentsService.getBuildEvents(
        input.deploymentId,
        input.buildId,
        { type: 'org', id: input.organizationId },
        input.limit,
        input.afterEventId
      );
    }),

  // Mutations
  deleteDeployment: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input }) => {
      return deploymentsService.deleteDeployment(input.id, {
        type: 'org',
        id: input.organizationId,
      });
    }),

  cancelBuild: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
        buildId: z.string().uuid(),
      })
    )
    .mutation(async ({ input }) => {
      return deploymentsService.cancelBuild(input.buildId, input.deploymentId, {
        type: 'org',
        id: input.organizationId,
      });
    }),

  redeploy: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input }) => {
      return deploymentsService.redeployByDeploymentId(input.id, {
        type: 'org',
        id: input.organizationId,
      });
    }),

  createDeployment: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        platformIntegrationId: z.string().uuid(),
        repositoryFullName: repoNameSchema,
        branch: branchSchema,
        envVars: z.array(plaintextEnvVarSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return deploymentsService.createDeployment({
        owner: { type: 'org', id: input.organizationId },
        source: {
          type: 'github',
          platformIntegrationId: input.platformIntegrationId,
          repositoryFullName: input.repositoryFullName,
        },
        branch: input.branch,
        createdByUserId: ctx.user.id,
        envVars: input.envVars,
      });
    }),

  checkSlugAvailability: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        slug: slugSchema,
      })
    )
    .query(async ({ input }) => {
      return deploymentsService.checkSlugAvailability(input.slug);
    }),

  renameDeployment: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
        newSlug: slugSchema,
      })
    )
    .mutation(async ({ input }) => {
      return deploymentsService.renameDeployment(input.deploymentId, input.newSlug, {
        type: 'org',
        id: input.organizationId,
      });
    }),

  setEnvVar: organizationMemberProcedure
    .input(
      baseEnvVarSchema.extend({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
      })
    )
    .mutation(async ({ input }) => {
      const { organizationId, deploymentId, key, value, isSecret } = input;
      const plaintextEnvVar = markAsPlaintext({ key, value, isSecret });
      // Encrypt before storing
      const [encryptedEnvVar] = envVarsService.encryptEnvVars([plaintextEnvVar]);
      await envVarsService.setEnvVar(deploymentId, encryptedEnvVar, {
        type: 'org',
        id: organizationId,
      });
    }),

  deleteEnvVar: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
        key: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      await envVarsService.deleteEnvVar(input.deploymentId, input.key, {
        type: 'org',
        id: input.organizationId,
      });
    }),

  listEnvVars: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      return envVarsService.listEnvVars(input.deploymentId, {
        type: 'org',
        id: input.organizationId,
      });
    }),

  renameEnvVar: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
        oldKey: z.string(),
        newKey: envVarKeySchema,
      })
    )
    .mutation(async ({ input }) => {
      await envVarsService.renameEnvVar(input.deploymentId, input.oldKey, input.newKey, {
        type: 'org',
        id: input.organizationId,
      });
    }),

  // Password protection endpoints (org-only feature)
  getPasswordStatus: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      // Get deployment to verify ownership and get worker name
      const { deployment } = await deploymentsService.getDeployment(input.deploymentId, {
        type: 'org',
        id: input.organizationId,
      });
      // Password records are keyed by internal worker name in the dispatcher
      return dispatcherClient.getPasswordStatus(deployment.internal_worker_name);
    }),

  setPassword: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
        password: z.string().min(8, 'Password must be at least 8 characters'),
      })
    )
    .mutation(async ({ input }) => {
      // Get deployment to verify ownership and get worker name
      const { deployment } = await deploymentsService.getDeployment(input.deploymentId, {
        type: 'org',
        id: input.organizationId,
      });
      // Password records are keyed by internal worker name in the dispatcher
      return dispatcherClient.setPassword(deployment.internal_worker_name, input.password);
    }),

  removePassword: organizationMemberProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        deploymentId: z.string().uuid(),
      })
    )
    .mutation(async ({ input }) => {
      // Get deployment to verify ownership and get worker name
      const { deployment } = await deploymentsService.getDeployment(input.deploymentId, {
        type: 'org',
        id: input.organizationId,
      });
      // Password records are keyed by internal worker name in the dispatcher
      return dispatcherClient.removePassword(deployment.internal_worker_name);
    }),
});

import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import { branchSchema, repoNameSchema, slugSchema } from '@/lib/user-deployments/validation';
import * as deploymentsService from '@/lib/user-deployments/deployments-service';
import * as envVarsService from '@/lib/user-deployments/env-vars-service';
import {
  envVarKeySchema,
  plaintextEnvVarSchema,
  baseEnvVarSchema,
  markAsPlaintext,
} from '@/lib/user-deployments/env-vars-validation';
import { hasUserEverPaid } from '@/lib/creditTransactions';

export const deploymentsRouter = createTRPCRouter({
  checkDeploymentEligibility: baseProcedure.query(async ({ ctx }) => {
    const canCreateDeployment = await hasUserEverPaid(ctx.user.id);
    return { canCreateDeployment };
  }),

  listDeployments: baseProcedure.query(async ({ ctx }) => {
    return deploymentsService.listDeployments({ type: 'user', id: ctx.user.id });
  }),

  getDeployment: baseProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return deploymentsService.getDeployment(input.id, { type: 'user', id: ctx.user.id });
    }),

  getBuildEvents: baseProcedure
    .input(
      z.object({
        deploymentId: z.string().uuid(),
        buildId: z.string().uuid(),
        limit: z.number().min(1).max(1000).optional().default(100),
        afterEventId: z.number().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      return deploymentsService.getBuildEvents(
        input.deploymentId,
        input.buildId,
        { type: 'user', id: ctx.user.id },
        input.limit,
        input.afterEventId
      );
    }),

  // Mutations
  deleteDeployment: baseProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return deploymentsService.deleteDeployment(input.id, { type: 'user', id: ctx.user.id });
    }),

  cancelBuild: baseProcedure
    .input(z.object({ deploymentId: z.string().uuid(), buildId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return deploymentsService.cancelBuild(input.buildId, input.deploymentId, {
        type: 'user',
        id: ctx.user.id,
      });
    }),

  redeploy: baseProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return deploymentsService.redeployByDeploymentId(input.id, { type: 'user', id: ctx.user.id });
    }),

  createDeployment: baseProcedure
    .input(
      z.object({
        platformIntegrationId: z.string().uuid(),
        repositoryFullName: repoNameSchema,
        branch: branchSchema,
        envVars: z.array(plaintextEnvVarSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return deploymentsService.createDeployment({
        owner: { type: 'user', id: ctx.user.id },
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

  checkSlugAvailability: baseProcedure
    .input(z.object({ slug: slugSchema }))
    .query(async ({ input }) => {
      return deploymentsService.checkSlugAvailability(input.slug);
    }),

  renameDeployment: baseProcedure
    .input(
      z.object({
        deploymentId: z.string().uuid(),
        newSlug: slugSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      return deploymentsService.renameDeployment(input.deploymentId, input.newSlug, {
        type: 'user',
        id: ctx.user.id,
      });
    }),

  setEnvVar: baseProcedure
    .input(
      baseEnvVarSchema.extend({
        deploymentId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { deploymentId, key, value, isSecret } = input;
      const plaintextEnvVar = markAsPlaintext({ key, value, isSecret });
      // Encrypt before storing
      const [encryptedEnvVar] = envVarsService.encryptEnvVars([plaintextEnvVar]);
      await envVarsService.setEnvVar(deploymentId, encryptedEnvVar, {
        type: 'user',
        id: ctx.user.id,
      });
    }),

  deleteEnvVar: baseProcedure
    .input(
      z.object({
        deploymentId: z.string().uuid(),
        key: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await envVarsService.deleteEnvVar(input.deploymentId, input.key, {
        type: 'user',
        id: ctx.user.id,
      });
    }),

  listEnvVars: baseProcedure
    .input(
      z.object({
        deploymentId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      return envVarsService.listEnvVars(input.deploymentId, { type: 'user', id: ctx.user.id });
    }),

  renameEnvVar: baseProcedure
    .input(
      z.object({
        deploymentId: z.string().uuid(),
        oldKey: z.string(),
        newKey: envVarKeySchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await envVarsService.renameEnvVar(input.deploymentId, input.oldKey, input.newKey, {
        type: 'user',
        id: ctx.user.id,
      });
    }),
});

import {
  cloudAgentWorktreeIdSchema,
  type CloudAgentWorkspaceSummary,
  validateCloudAgentRootSessionsCursor,
  validateCloudAgentWorkspacesCursor,
} from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import { protectedProcedure } from '../auth.js';
import { hostedSessionSummarySchema } from './hosted-session-list.js';

const hostedWorkspaceSessionSummarySchema = hostedSessionSummarySchema.extend({
  workspaceId: cloudAgentWorktreeIdSchema,
});

const hostedWorkspaceSummarySchema = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    userId: z.string().min(1),
    organizationId: z.string().nullable(),
    name: z.string().nullable(),
    repositoryProvider: z.enum(['github', 'gitlab', 'bitbucket', 'git']).nullable(),
    gitUrl: z.string().max(2048).nullable(),
    gitBranch: z.string().max(512).nullable(),
    profileId: z.string().nullable(),
    deletionState: z.enum(['active', 'deleting', 'deleted']),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    lastActivity: z.number().int().nonnegative(),
    sessions: z.array(hostedWorkspaceSessionSummarySchema),
    nextSessionCursor: z
      .string()
      .min(1)
      .max(256)
      .refine(validateCloudAgentRootSessionsCursor)
      .nullable(),
  })
  .strict();

export const listHostedWorkspacesInput = z
  .object({
    limit: z.number().int().min(1).max(50).default(50),
    sessionLimit: z.number().int().min(1).max(100).default(10),
    cursor: z
      .string()
      .min(1)
      .max(256)
      .refine(validateCloudAgentWorkspacesCursor, 'Invalid hosted workspaces cursor')
      .optional(),
    repositoryUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const listHostedWorkspacesOutput = z
  .object({
    items: z.array(hostedWorkspaceSummarySchema),
    nextCursor: z.string().min(1).max(256).refine(validateCloudAgentWorkspacesCursor).nullable(),
  })
  .strict();

export const getHostedWorkspaceInput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    sessionLimit: z.number().int().min(1).max(100).default(100),
    sessionCursor: z
      .string()
      .min(1)
      .max(256)
      .refine(validateCloudAgentRootSessionsCursor, 'Invalid hosted sessions cursor')
      .optional(),
  })
  .strict();

export const getHostedWorkspaceOutput = hostedWorkspaceSummarySchema.nullable();

export const listHostedWorkspaces = protectedProcedure
  .input(listHostedWorkspacesInput)
  .output(listHostedWorkspacesOutput)
  .query(async ({ input, ctx }) => {
    const page = await ctx.env.SESSION_INGEST.listCloudAgentWorkspaces({
      kiloUserId: ctx.userId,
      ...input,
    });
    return {
      items: page.items.map(workspace => projectWorkspace(workspace, ctx.userId)),
      nextCursor: page.nextCursor,
    };
  });

export const getHostedWorkspace = protectedProcedure
  .input(getHostedWorkspaceInput)
  .output(getHostedWorkspaceOutput)
  .query(async ({ input, ctx }) => {
    const workspace = await ctx.env.SESSION_INGEST.getCloudAgentWorkspace({
      kiloUserId: ctx.userId,
      ...input,
    });
    if (!workspace) return null;
    return projectWorkspace(workspace, ctx.userId);
  });

function projectWorkspace(workspace: CloudAgentWorkspaceSummary, userId: string) {
  return {
    ...workspace,
    userId,
    sessions: workspace.sessions.map(session => ({
      ...session,
      workspaceId: cloudAgentWorktreeIdSchema.parse(session.workspaceId),
      userId,
    })),
  };
}

import 'server-only';
import { createTRPCRouter } from '@/lib/trpc/init';
import { generateApiToken } from '@/lib/tokens';
import { organizationMemberProcedure } from '@/routers/organizations/utils';
import * as appBuilderService from '@/lib/app-builder/app-builder-service';
import {
  createProjectBaseSchema,
  projectIdBaseSchema,
  sendMessageBaseSchema,
  organizationIdSchema,
  getImageUploadUrlSchema,
  prepareLegacySessionBaseSchema,
  migrateToGitHubSchema,
} from '@/routers/app-builder/schemas';
import { getBalanceForOrganizationUser } from '@/lib/organizations/organization-usage';
import { MIN_BALANCE_FOR_APP_BUILDER } from '@/lib/app-builder/constants';
import { generateImageUploadUrl } from '@/lib/r2/cloud-agent-attachments';

// Input schemas with required organizationId
const createProjectSchema = createProjectBaseSchema.merge(organizationIdSchema);
const projectWithOrgIdSchema = projectIdBaseSchema.merge(organizationIdSchema);
const sendMessageSchema = sendMessageBaseSchema.merge(organizationIdSchema);
const deployProjectSchema = projectIdBaseSchema.merge(organizationIdSchema);
const imageUploadUrlWithOrgIdSchema = getImageUploadUrlSchema.merge(organizationIdSchema);
const prepareLegacySessionSchema = prepareLegacySessionBaseSchema.merge(organizationIdSchema);
const migrateToGitHubWithOrgIdSchema = migrateToGitHubSchema.merge(organizationIdSchema);

export const organizationAppBuilderRouter = createTRPCRouter({
  /**
   * Create a new project without starting streaming
   * Returns projectId for the client to navigate to before streaming
   */
  createProject: organizationMemberProcedure
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      const authToken = generateApiToken(ctx.user);

      return appBuilderService.createProject({
        owner,
        prompt: input.prompt,
        model: input.model,
        title: input.title,
        createdByUserId: ctx.user.id,
        authToken,
        images: input.images,
        template: input.template,
        mode: input.mode,
      });
    }),

  /**
   * Get preview URL for a project
   */
  getPreviewUrl: organizationMemberProcedure
    .input(projectWithOrgIdSchema)
    .query(async ({ input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      return appBuilderService.getPreviewUrl(input.projectId, owner);
    }),

  /**
   * Triggers a build for the specified project
   */
  triggerBuild: organizationMemberProcedure
    .input(projectWithOrgIdSchema)
    .mutation(async ({ input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      return appBuilderService.triggerProjectBuild(input.projectId, owner);
    }),

  /**
   * Get a single project with all messages and session state
   */
  getProject: organizationMemberProcedure
    .input(projectWithOrgIdSchema)
    .query(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      const authToken = generateApiToken(ctx.user);
      return appBuilderService.getProject(input.projectId, owner, authToken);
    }),

  /**
   * List all projects for the organization
   */
  listProjects: organizationMemberProcedure.query(async ({ input }) => {
    const owner = { type: 'org' as const, id: input.organizationId };
    return appBuilderService.listProjects(owner);
  }),

  /**
   * List projects created by the current user within the organization
   */
  listUserProjects: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const owner = { type: 'org' as const, id: input.organizationId };
    return appBuilderService.listProjects(owner, { createdByUserId: ctx.user.id });
  }),

  /**
   * Deploy an App Builder project to production
   */
  deployProject: organizationMemberProcedure
    .input(deployProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      return appBuilderService.deployProject(input.projectId, owner, ctx.user.id);
    }),

  /**
   * Check user's access level for App Builder within organization context.
   *
   * Returns:
   * - accessLevel: 'full' | 'limited' | 'blocked'
   *   - 'full': User has enough balance ($1+) to use all models
   *   - 'limited': User can use free models only (balance below $1)
   *   - 'blocked': Reserved for future use (e.g., if we need to block users entirely)
   *
   * Currently returns only 'full' or 'limited' - UI supports 'blocked' for easy future switch.
   */
  checkEligibility: organizationMemberProcedure.query(async ({ ctx, input }) => {
    const { balance } = await getBalanceForOrganizationUser(input.organizationId, ctx.user.id);

    // Determine access level based on balance
    // Currently only 'full' or 'limited' - change to 'blocked' if we need to restrict entirely
    const accessLevel: 'full' | 'limited' | 'blocked' =
      balance >= MIN_BALANCE_FOR_APP_BUILDER ? 'full' : 'limited';

    return {
      balance,
      minBalance: MIN_BALANCE_FOR_APP_BUILDER,
      accessLevel,
      // Keep isEligible for backwards compatibility (true if full access)
      isEligible: accessLevel === 'full',
    };
  }),

  /**
   * Generate a read-only clone token for a project
   * Returns the token, git URL, and expiration time
   */
  generateCloneToken: organizationMemberProcedure
    .input(projectWithOrgIdSchema)
    .mutation(async ({ input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      return appBuilderService.generateCloneToken(input.projectId, owner);
    }),

  /**
   * Delete a project and all associated resources
   */
  deleteProject: organizationMemberProcedure
    .input(projectWithOrgIdSchema)
    .mutation(async ({ input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      await appBuilderService.deleteProject(input.projectId, owner);
      return { success: true };
    }),

  /**
   * Interrupt a running App Builder session
   * Stops any ongoing Claude agent execution for the project
   */
  interruptSession: organizationMemberProcedure
    .input(projectWithOrgIdSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      const authToken = generateApiToken(ctx.user);
      const result = await appBuilderService.interruptSession(input.projectId, owner, authToken);
      return { success: result.success };
    }),

  /**
   * Generate a presigned URL for uploading an image attachment
   * Note: Uses ctx.user.id for the folder path since images are user-created content
   */
  getImageUploadUrl: organizationMemberProcedure
    .input(imageUploadUrlWithOrgIdSchema)
    .mutation(async ({ ctx, input }) => {
      return generateImageUploadUrl({
        service: 'app-builder',
        userId: ctx.user.id,
        messageUuid: input.messageUuid,
        imageId: input.imageId,
        contentType: input.contentType,
        contentLength: input.contentLength,
      });
    }),

  // ============================================================================
  // WebSocket-based streaming mutations
  // ============================================================================

  /**
   * Start a Cloud Agent session for an existing project using WebSocket API.
   * Returns immediately with session info - client connects to WebSocket separately for events.
   *
   * This is a mutation (not subscription) - it triggers the action and returns immediately.
   * The client should then:
   * 1. Fetch a stream ticket from /api/cloud-agent/sessions/stream-ticket
   * 2. Connect to the WebSocket URL with the ticket
   */
  startSession: organizationMemberProcedure
    .input(projectWithOrgIdSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      const authToken = generateApiToken(ctx.user);

      const result = await appBuilderService.startSessionForProject({
        projectId: input.projectId,
        owner,
        authToken,
      });

      return { cloudAgentSessionId: result.cloudAgentSessionId };
    }),

  /**
   * Send a message to an existing App Builder session using WebSocket API.
   * Returns immediately with session info - client connects to WebSocket separately for events.
   *
   * This is a mutation (not subscription) - it triggers the action and returns immediately.
   * The client should then:
   * 1. Fetch a stream ticket from /api/cloud-agent/sessions/stream-ticket
   * 2. Connect to the WebSocket URL with the ticket
   */
  sendMessage: organizationMemberProcedure
    .input(sendMessageSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      const authToken = generateApiToken(ctx.user);

      const result = await appBuilderService.sendMessage({
        projectId: input.projectId,
        owner,
        message: input.message,
        authToken,
        images: input.images,
        model: input.model,
      });

      return { cloudAgentSessionId: result.cloudAgentSessionId };
    }),

  /**
   * Prepare a legacy session and initiate it for WebSocket-based streaming.
   *
   * Legacy sessions (created before the prepare flow) don't have session state stored
   * in the Durable Object, which means WebSocket replay doesn't work. This endpoint:
   * 1. Backfills the DO with session metadata
   * 2. Initiates the session to execute the first message
   *
   * Returns the cloudAgentSessionId for WebSocket connection.
   * The client should connect to the WebSocket to receive the response.
   */
  prepareLegacySession: organizationMemberProcedure
    .input(prepareLegacySessionSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      const authToken = generateApiToken(ctx.user);

      const result = await appBuilderService.prepareLegacySession(
        input.projectId,
        owner,
        authToken,
        input.model,
        input.prompt
      );

      return { cloudAgentSessionId: result.cloudAgentSessionId };
    }),

  // ============================================================================
  // GitHub Migration
  // ============================================================================

  /**
   * Pre-flight check for GitHub migration.
   */
  canMigrateToGitHub: organizationMemberProcedure
    .input(projectWithOrgIdSchema)
    .query(async ({ input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      return appBuilderService.canMigrateToGitHub(input.projectId, owner);
    }),

  /**
   * Migrate an App Builder project to GitHub.
   */
  migrateToGitHub: organizationMemberProcedure
    .input(migrateToGitHubWithOrgIdSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };

      return appBuilderService.migrateProjectToGitHub({
        projectId: input.projectId,
        owner,
        userId: ctx.user.id,
        repoFullName: input.repoFullName,
      });
    }),
});

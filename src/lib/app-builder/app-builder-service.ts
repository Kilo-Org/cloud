import 'server-only';
import type { Owner } from '@/lib/integrations/core/types';
import {
  createAppBuilderCloudAgentClient,
  type InterruptResult,
  type InitiateSessionV2Output,
} from '@/lib/cloud-agent/cloud-agent-client';
import * as appBuilderClient from '@/lib/app-builder/app-builder-client';
import { APP_BUILDER_APPEND_SYSTEM_PROMPT } from '@/lib/app-builder/constants';
import { db } from '@/lib/drizzle';
import { app_builder_projects, cliSessions } from '@/db/schema';
import { TRPCError } from '@trpc/server';
import { eq, and, sql } from 'drizzle-orm';
import type { CloudMessage } from '@/components/cloud-agent/types';
import { APP_BUILDER_URL } from '@/lib/config.server';
import { createDeployment, getDeployment } from '@/lib/user-deployments/deployments-service';
import { getHistoricalMessages } from '@/lib/app-builder/historical-messages';
import type {
  AppBuilderProject,
  CreateProjectInput,
  CreateProjectResult,
  StartSessionInput,
  SendMessageInput,
  DeployProjectResult,
  ProjectWithMessages,
} from '@/lib/app-builder/types';

export type {
  AppBuilderProject,
  CreateProjectInput,
  CreateProjectResult,
  StartSessionInput,
  SendMessageInput,
  DeployProjectResult,
  ProjectWithMessages,
};

// ============================================================================
// Private Helper Functions
// ============================================================================

/**
 * Construct the git URL for an App Builder project.
 */
function getProjectGitUrl(projectId: string): string {
  return `${APP_BUILDER_URL}/apps/${projectId}.git`;
}

export async function getProjectWithOwnershipCheck(
  projectId: string,
  owner: Owner
): Promise<AppBuilderProject> {
  const ownerCondition =
    owner.type === 'org'
      ? eq(app_builder_projects.owned_by_organization_id, owner.id)
      : eq(app_builder_projects.owned_by_user_id, owner.id);

  const [project] = await db
    .select()
    .from(app_builder_projects)
    .where(and(eq(app_builder_projects.id, projectId), ownerCondition));

  if (!project) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Project not found',
    });
  }

  return project;
}

// ============================================================================
// Exported Functions
// ============================================================================

export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const { owner, prompt, model, title, createdByUserId, authToken, images, mode } = input;

  const trimmedTitle = title?.trim();
  const projectTitle = trimmedTitle || prompt.trim();

  const template = input.template ?? 'nextjs-starter';

  // Create project in database with generated UUID
  const [project] = await db
    .insert(app_builder_projects)
    .values({
      created_by_user_id: createdByUserId,
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      title: projectTitle,
      model_id: model,
      template: template,
      last_message_at: new Date().toISOString(),
    })
    .returning();

  const projectId = project.id;

  // Initialize git repository via App Builder API
  try {
    await appBuilderClient.initProject(projectId, {
      template: template,
    });

    // Prepare the cloud agent session
    const client = createAppBuilderCloudAgentClient(authToken);
    const gitUrl = getProjectGitUrl(projectId);
    const { token: gitToken } = await appBuilderClient.generateGitToken(projectId, 'full');

    const { cloudAgentSessionId } = await client.prepareSession({
      gitUrl,
      gitToken,
      prompt,
      mode: mode ?? 'code',
      model,
      upstreamBranch: 'main',
      autoCommit: true,
      setupCommands: ['bun install'],
      kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
      images,
      appendSystemPrompt: APP_BUILDER_APPEND_SYSTEM_PROMPT,
    });

    // Save the session ID to the project
    await db
      .update(app_builder_projects)
      .set({ session_id: cloudAgentSessionId })
      .where(eq(app_builder_projects.id, projectId));

    return { projectId };
  } catch (error) {
    // Clean up project if anything fails
    await db.delete(app_builder_projects).where(eq(app_builder_projects.id, projectId));

    const errorMsg = error instanceof Error ? error.message : 'Failed to initialize project';
    throw new TRPCError({
      code: error instanceof TRPCError ? error.code : 'INTERNAL_SERVER_ERROR',
      message: errorMsg,
    });
  }
}

/**
 * Get preview URL for a project.
 */
export async function getPreviewUrl(
  projectId: string,
  owner: Owner
): Promise<{ status: string; previewUrl: string | null }> {
  // Validate ownership
  await getProjectWithOwnershipCheck(projectId, owner);

  // Get preview from App Builder API
  const preview = await appBuilderClient.getPreview(projectId);

  return {
    status: preview.status,
    previewUrl: preview.previewUrl,
  };
}

/**
 * Trigger a build for the project.
 */
export async function triggerProjectBuild(
  projectId: string,
  owner: Owner
): Promise<{ success: true }> {
  // Validate ownership
  await getProjectWithOwnershipCheck(projectId, owner);

  // Call the build trigger
  await appBuilderClient.triggerBuild(projectId);

  return { success: true };
}

/**
 * Get a single project with all messages and session state.
 * Fetches session state from cloud-agent to determine if session needs to be initiated.
 *
 * For prepared sessions (new flow): Messages are fetched via WebSocket replay from cloud-agent.
 * For legacy sessions (no preparedAt): Messages are fetched from R2 via cli_sessions table.
 */
export async function getProject(
  projectId: string,
  owner: Owner,
  authToken: string
): Promise<ProjectWithMessages> {
  const project = await getProjectWithOwnershipCheck(projectId, owner);

  // Determine session state by checking cloud-agent
  let sessionInitiated: boolean | null = null;
  let sessionPrepared: boolean | null = null;
  let messages: CloudMessage[] = [];

  if (project.session_id) {
    try {
      const client = createAppBuilderCloudAgentClient(authToken);
      const sessionState = await client.getSession(project.session_id);

      // Session is prepared if preparedAt timestamp is set
      sessionPrepared = sessionState.preparedAt != null;
      // Session is initiated if initiatedAt timestamp is set
      sessionInitiated = sessionState.initiatedAt != null;

      // For legacy sessions (not prepared or prepared before 2026-01-22 10:00 UTC), fetch historical messages from R2
      // New sessions get their messages via WebSocket replay from the DO
      const migrationCutoffTimestamp = Date.UTC(2026, 0, 22, 10, 0, 0); // 2026-01-22 10:00:00 UTC
      if (
        !sessionPrepared ||
        (sessionState.preparedAt && sessionState.preparedAt < migrationCutoffTimestamp)
      ) {
        messages = await getHistoricalMessages(project.session_id);
      }

      // For new sessions (not yet initiated), include the initial prompt as first message
      // This provides instant display when navigating from landing page to project.
      // Uses say: 'user_feedback' to match WebSocket format for content-based deduplication
      // (see updateMessage in messages.ts - dedup only triggers for user_feedback messages)
      if (messages.length === 0 && sessionInitiated === false && sessionState.prompt) {
        messages = [
          {
            ts: sessionState.preparedAt ?? Date.now(),
            type: 'user',
            say: 'user_feedback',
            text: sessionState.prompt,
            partial: false,
          },
        ];
      }
    } catch {
      // If we can't reach cloud-agent, default to null (unknown state)
      // The client can fall back to checking messages in this case
      sessionInitiated = null;
      sessionPrepared = null;
    }
  }

  return {
    ...project,
    messages,
    sessionInitiated,
    sessionPrepared,
  };
}

type ListProjectsOptions = {
  /** Filter to only projects created by this user (for org context) */
  createdByUserId?: string;
};

/**
 * List all projects for the owner.
 * @param owner - The owner (user or org) to list projects for
 * @param options - Optional filters
 * @param options.createdByUserId - Filter to only projects created by this user (useful for org context)
 */
export async function listProjects(
  owner: Owner,
  options?: ListProjectsOptions
): Promise<AppBuilderProject[]> {
  const conditions = [
    owner.type === 'org'
      ? eq(app_builder_projects.owned_by_organization_id, owner.id)
      : eq(app_builder_projects.owned_by_user_id, owner.id),
  ];

  if (options?.createdByUserId) {
    conditions.push(eq(app_builder_projects.created_by_user_id, options.createdByUserId));
  }

  return db
    .select()
    .from(app_builder_projects)
    .where(and(...conditions))
    .orderBy(sql`${app_builder_projects.last_message_at} DESC NULLS LAST`);
}

/**
 * Deploy an App Builder project to production.
 */
export async function deployProject(
  projectId: string,
  owner: Owner,
  createdByUserId: string
): Promise<DeployProjectResult> {
  // Validate ownership and get project
  const project = await getProjectWithOwnershipCheck(projectId, owner);

  // Check if already deployed - return existing deployment info
  if (project.deployment_id) {
    const deploymentResult = await getDeployment(project.deployment_id, owner);
    return {
      success: true,
      deploymentId: project.deployment_id,
      deploymentUrl: deploymentResult.deployment.deployment_url,
      alreadyDeployed: true,
    };
  }

  const gitUrl = getProjectGitUrl(projectId);

  // Use createDeployment with app-builder source type
  // Tokens and DB credentials are generated on-the-fly by the deployment service
  const result = await createDeployment({
    owner,
    source: {
      type: 'app-builder',
      gitUrl,
    },
    branch: 'main',
    createdByUserId,
  });

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      message: result.message,
    };
  }

  await db
    .update(app_builder_projects)
    .set({ deployment_id: result.deploymentId })
    .where(eq(app_builder_projects.id, projectId));

  return {
    success: true,
    deploymentId: result.deploymentId,
    deploymentUrl: result.deploymentUrl,
    alreadyDeployed: false,
  };
}

/**
 * Generate a read-only clone token for a project.
 * Returns the token, git URL, and expiration time.
 */
export async function generateCloneToken(
  projectId: string,
  owner: Owner
): Promise<{ token: string; gitUrl: string; expiresAt: string }> {
  // Validate ownership
  await getProjectWithOwnershipCheck(projectId, owner);

  // Generate read-only token
  const { token, expiresAt } = await appBuilderClient.generateGitToken(projectId, 'ro');

  return {
    token,
    gitUrl: getProjectGitUrl(projectId),
    expiresAt,
  };
}

/**
 * Delete a project and all associated resources.
 */
export async function deleteProject(projectId: string, owner: Owner): Promise<void> {
  await getProjectWithOwnershipCheck(projectId, owner);

  await appBuilderClient.deleteProject(projectId);
  await db.delete(app_builder_projects).where(eq(app_builder_projects.id, projectId));
}

/**
 * Interrupt a running App Builder session.
 * This stops any ongoing Claude agent execution for the project.
 *
 * @param projectId - The project ID to interrupt
 * @param owner - The owner (user or org) for authorization
 * @param authToken - JWT auth token for cloud agent authentication
 * @returns Promise resolving to interrupt result with lists of killed/failed process IDs
 */
export async function interruptSession(
  projectId: string,
  owner: Owner,
  authToken: string
): Promise<InterruptResult> {
  const project = await getProjectWithOwnershipCheck(projectId, owner);

  if (!project.session_id) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'No active session found for this project',
    });
  }

  const client = createAppBuilderCloudAgentClient(authToken);
  return client.interruptSession(project.session_id);
}

// ============================================================================
// WebSocket-based streaming functions
// ============================================================================

/**
 * Start a Cloud Agent session for a project using the WebSocket-based API.
 * Returns immediately with session info - client connects to WebSocket separately for events.
 *
 * The session must have been prepared during createProject via prepareSession.
 */
export async function startSessionForProject(
  input: StartSessionInput
): Promise<InitiateSessionV2Output> {
  const { projectId, owner, authToken } = input;

  const project = await getProjectWithOwnershipCheck(projectId, owner);

  // Session should already be prepared during createProject
  if (!project.session_id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Project session not prepared',
    });
  }

  // App Builder handles its own billing, skip balance check in cloud-agent
  const client = createAppBuilderCloudAgentClient(authToken);

  const existingSession = await client.getSession(project.session_id);
  if (existingSession.initiatedAt) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Session already initiated.',
    });
  }

  // Initiate the prepared session using V2 mutation (returns immediately)
  const result = await client.initiateFromKilocodeSessionV2({
    cloudAgentSessionId: project.session_id,
  });

  return {
    cloudAgentSessionId: result.cloudAgentSessionId,
    executionId: result.executionId,
    status: result.status,
    streamUrl: result.streamUrl,
  };
}

/**
 * Send a message to an existing App Builder session using the WebSocket-based API.
 * Returns immediately with session info - client connects to WebSocket separately for events.
 */
export async function sendMessage(input: SendMessageInput): Promise<InitiateSessionV2Output> {
  const { projectId, owner, message, authToken, images, model } = input;

  const project = await getProjectWithOwnershipCheck(projectId, owner);

  if (!project.session_id) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Project not found',
    });
  }

  // Determine which model to use - prefer override, fallback to project's stored model
  const effectiveModel = model ?? project.model_id;

  // If model changed, update the project's model_id
  if (model && model !== project.model_id) {
    await db
      .update(app_builder_projects)
      .set({ model_id: model })
      .where(eq(app_builder_projects.id, projectId));
  }

  // Create Cloud Agent client - App Builder handles its own billing, skip balance check
  const client = createAppBuilderCloudAgentClient(authToken);

  // Generate a fresh token with full permissions for the cloud agent
  const { token: gitToken } = await appBuilderClient.generateGitToken(projectId, 'full');

  // Send message to existing session using V2 mutation (returns immediately)
  const result = await client.sendMessageV2({
    cloudAgentSessionId: project.session_id,
    prompt: message,
    mode: 'code',
    model: effectiveModel,
    autoCommit: true,
    gitToken,
    images,
    condenseOnComplete: true,
  });

  return {
    cloudAgentSessionId: result.cloudAgentSessionId,
    executionId: result.executionId,
    status: result.status,
    streamUrl: result.streamUrl,
  };
}

/**
 * Prepare a legacy session and initiate it for WebSocket-based streaming.
 *
 * Legacy sessions (created before the prepare flow) don't have session state stored
 * in the Durable Object, which means WebSocket replay doesn't work. This function:
 * 1. Calls prepareLegacySession on cloud-agent to backfill the DO with session metadata
 * 2. Calls initiateFromKilocodeSessionV2 to execute the first prompt (which is stored in step 1)
 *
 * NOTE: This does NOT backfill historical messages to the DO. Historical messages
 * for legacy sessions are fetched from R2 via getHistoricalMessages().
 *
 * @param projectId - The project ID to prepare
 * @param owner - The owner (user or org) for authorization
 * @param authToken - JWT auth token for cloud agent authentication
 * @param model - Model to use for this message
 * @param prompt - The user's message to send (stored in DO and executed via initiateFromKilocodeSessionV2)
 * @returns InitiateSessionV2Output with session info for WebSocket connection
 */
export async function prepareLegacySession(
  projectId: string,
  owner: Owner,
  authToken: string,
  model: string,
  prompt: string
): Promise<InitiateSessionV2Output> {
  const project = await getProjectWithOwnershipCheck(projectId, owner);

  if (!project.session_id) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Project has no session',
    });
  }

  const client = createAppBuilderCloudAgentClient(authToken);
  const gitUrl = getProjectGitUrl(projectId);
  const { token: gitToken } = await appBuilderClient.generateGitToken(projectId, 'full');

  // Look up the kiloSessionId from the cli_sessions table
  const [cliSession] = await db
    .select({ session_id: cliSessions.session_id })
    .from(cliSessions)
    .where(eq(cliSessions.cloud_agent_session_id, project.session_id))
    .limit(1);

  if (!cliSession) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'No CLI session found for this project',
    });
  }

  // Step 1: Prepare the legacy session by backfilling DO state
  await client.prepareLegacySession({
    cloudAgentSessionId: project.session_id,
    kiloSessionId: cliSession.session_id,
    prompt,
    gitUrl,
    gitToken,
    mode: 'code',
    model,
    upstreamBranch: 'main',
    autoCommit: true,
    setupCommands: ['bun install'],
    kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
  });

  // Step 2: Initiate the prepared session (consumes the prompt stored in step 1)
  const result = await client.initiateFromKilocodeSessionV2({
    cloudAgentSessionId: project.session_id,
    kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
  });

  return {
    cloudAgentSessionId: result.cloudAgentSessionId,
    executionId: result.executionId,
    status: result.status,
    streamUrl: result.streamUrl,
  };
}

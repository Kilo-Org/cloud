import 'server-only';
import type { Owner } from '@/lib/integrations/core/types';
import {
  createAppBuilderCloudAgentClient,
  type InterruptResult,
  type InitiateSessionV2Output,
} from '@/lib/cloud-agent/cloud-agent-client';
import {
  createAppBuilderCloudAgentNextClient,
  type InterruptResult as InterruptResultV2,
  type InitiateSessionOutput as InitiateSessionV2OutputNext,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import * as appBuilderClient from '@/lib/app-builder/app-builder-client';
import { APP_BUILDER_APPEND_SYSTEM_PROMPT } from '@/lib/app-builder/constants';
import { db } from '@/lib/drizzle';
import {
  app_builder_projects,
  app_builder_project_sessions,
  AppBuilderSessionReason,
  cliSessions,
} from '@/db/schema';
import { TRPCError } from '@trpc/server';
import { eq, and, sql, asc } from 'drizzle-orm';
import type { CloudMessage } from '@/components/cloud-agent/types';
import { APP_BUILDER_URL } from '@/lib/config.server';
import { createDeployment, getDeployment } from '@/lib/user-deployments/deployments-service';
import type { DeploymentSource } from '@/lib/user-deployments/types';
import { getHistoricalMessages } from '@/lib/app-builder/historical-messages';

import type {
  AppBuilderProject,
  CreateProjectInput,
  CreateProjectResult,
  StartSessionInput,
  SendMessageInput,
  DeployProjectResult,
  ProjectWithMessages,
  ProjectSessionInfo,
  WorkerVersion,
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

export {
  canMigrateToGitHub,
  migrateProjectToGitHub,
} from '@/lib/app-builder/github-migration-service';

export type {
  MigrateToGitHubInput,
  MigrateToGitHubResult,
  CanMigrateToGitHubResult,
} from '@/lib/app-builder/types';

// ============================================================================
// Private Helper Functions
// ============================================================================

/**
 * Construct the git URL for an App Builder project.
 */
function getProjectGitUrl(projectId: string): string {
  return `${APP_BUILDER_URL}/apps/${projectId}.git`;
}

/**
 * Parse and validate a worker_version string from the database.
 * Returns null for unknown/invalid values rather than throwing.
 */
function parseWorkerVersion(value: string | null): WorkerVersion | null {
  if (value === 'v1' || value === 'v2') return value;
  return null;
}

/**
 * Feature flag name for cloud-agent-next usage in App Builder.
 */
const APP_BUILDER_USE_CLOUD_AGENT_NEXT_FLAG = 'APP_BUILDER_USE_CLOUD_AGENT_NEXT';

/**
 * Check if new sessions should use cloud-agent-next (v2).
 */
async function shouldUseCloudAgentNext(): Promise<boolean> {
  return isFeatureFlagEnabled(APP_BUILDER_USE_CLOUD_AGENT_NEXT_FLAG);
}

/**
 * Get the required worker version based on the feature flag.
 */
async function getRequiredWorkerVersion(): Promise<WorkerVersion> {
  return (await shouldUseCloudAgentNext()) ? 'v2' : 'v1';
}

/**
 * Fetch all sessions for a project, ordered by created_at ascending.
 */
async function getProjectSessions(projectId: string): Promise<ProjectSessionInfo[]> {
  const rows = await db
    .select({
      id: app_builder_project_sessions.id,
      cloud_agent_session_id: app_builder_project_sessions.cloud_agent_session_id,
      worker_version: app_builder_project_sessions.worker_version,
      created_at: app_builder_project_sessions.created_at,
      ended_at: app_builder_project_sessions.ended_at,
      reason: app_builder_project_sessions.reason,
    })
    .from(app_builder_project_sessions)
    .where(eq(app_builder_project_sessions.project_id, projectId))
    .orderBy(asc(app_builder_project_sessions.created_at));

  return rows.map(row => ({
    id: row.id,
    cloud_agent_session_id: row.cloud_agent_session_id,
    worker_version: parseWorkerVersion(row.worker_version) ?? 'v1',
    created_at: row.created_at,
    ended_at: row.ended_at,
    reason: row.reason,
  }));
}

/**
 * Get the current (active) session's worker version for a project.
 * Returns null if no active session exists.
 */
async function getCurrentSessionWorkerVersion(
  projectSessionId: string
): Promise<WorkerVersion | null> {
  const [row] = await db
    .select({ worker_version: app_builder_project_sessions.worker_version })
    .from(app_builder_project_sessions)
    .where(eq(app_builder_project_sessions.cloud_agent_session_id, projectSessionId))
    .limit(1);

  if (!row) return null;
  return parseWorkerVersion(row.worker_version);
}

/**
 * Union type for interrupt results from v1 and v2 clients.
 */
type AnyInterruptResult = InterruptResult | InterruptResultV2;

export { getProjectWithOwnershipCheck } from '@/lib/app-builder/project-ownership';
import { getProjectWithOwnershipCheck } from '@/lib/app-builder/project-ownership';

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

    // Determine which worker version to use based on feature flag
    const workerVersion = await getRequiredWorkerVersion();

    const gitUrl = getProjectGitUrl(projectId);
    const { token: gitToken } = await appBuilderClient.generateGitToken(projectId, 'full');

    const sharedParams = {
      gitUrl,
      gitToken,
      prompt,
      model,
      upstreamBranch: 'main' as const,
      autoCommit: true,
      setupCommands: ['bun install'],
      kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
      images,
      appendSystemPrompt: APP_BUILDER_APPEND_SYSTEM_PROMPT,
      createdOnPlatform: 'app-builder',
    };

    let cloudAgentSessionId: string;

    if (workerVersion === 'v2') {
      const client = createAppBuilderCloudAgentNextClient(authToken);
      const result = await client.prepareSession({
        ...sharedParams,
        mode: mode === 'ask' ? 'plan' : 'build',
      });
      cloudAgentSessionId = result.cloudAgentSessionId;
    } else {
      const client = createAppBuilderCloudAgentClient(authToken);
      const result = await client.prepareSession({
        ...sharedParams,
        mode: mode ?? 'code',
      });
      cloudAgentSessionId = result.cloudAgentSessionId;
    }

    // Save session ID and track it atomically
    await db.transaction(async tx => {
      await tx
        .update(app_builder_projects)
        .set({ session_id: cloudAgentSessionId })
        .where(eq(app_builder_projects.id, projectId));

      await tx.insert(app_builder_project_sessions).values({
        project_id: projectId,
        cloud_agent_session_id: cloudAgentSessionId,
        reason: AppBuilderSessionReason.Initial,
        worker_version: workerVersion,
      });
    });

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

  // Fetch all sessions for this project
  const sessions = await getProjectSessions(projectId);

  // Determine session state by checking cloud-agent
  let sessionInitiated: boolean | null = null;
  let sessionPrepared: boolean | null = null;
  let messages: CloudMessage[] = [];

  if (project.session_id) {
    try {
      // Determine which client to use based on the current session's worker version
      const currentWorkerVersion = await getCurrentSessionWorkerVersion(project.session_id);

      if (currentWorkerVersion === 'v2') {
        // V2 session: get state from cloud-agent-next
        const v2Client = createAppBuilderCloudAgentNextClient(authToken);
        const sessionState = await v2Client.getSession(project.session_id);

        sessionPrepared = sessionState.preparedAt != null;
        sessionInitiated = sessionState.initiatedAt != null;

        // V2 sessions get messages via WebSocket replay, no historical messages needed
        // For new sessions (not yet initiated), include initial prompt
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
      } else {
        // V1 session: use old cloud-agent client
        const v1Client = createAppBuilderCloudAgentClient(authToken);
        const sessionState = await v1Client.getSession(project.session_id);

        sessionPrepared = sessionState.preparedAt != null;
        sessionInitiated = sessionState.initiatedAt != null;

        // For legacy sessions (not prepared or prepared before cutoff), fetch historical messages from R2
        const migrationCutoffTimestamp = Date.UTC(2026, 0, 22, 10, 0, 0);
        if (
          !sessionPrepared ||
          (sessionState.preparedAt && sessionState.preparedAt < migrationCutoffTimestamp)
        ) {
          messages = await getHistoricalMessages(project.session_id);
        }

        // For new sessions (not yet initiated), include the initial prompt as first message
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
      }
    } catch {
      sessionInitiated = null;
      sessionPrepared = null;
    }
  }

  return {
    ...project,
    messages,
    sessions,
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

  // If project was migrated to GitHub, deploy from GitHub; otherwise use internal git repo
  const { git_repo_full_name, git_platform_integration_id } = project;
  const source: DeploymentSource =
    git_repo_full_name && git_platform_integration_id
      ? {
          type: 'github',
          repositoryFullName: git_repo_full_name,
          platformIntegrationId: git_platform_integration_id,
        }
      : {
          type: 'app-builder',
          gitUrl: getProjectGitUrl(projectId),
        };

  const result = await createDeployment({
    owner,
    source,
    branch: 'main',
    createdByUserId,
    createdFrom: 'app-builder',
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
): Promise<AnyInterruptResult> {
  const project = await getProjectWithOwnershipCheck(projectId, owner);

  if (!project.session_id) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'No active session found for this project',
    });
  }

  // Route to the correct cloud agent based on session's worker version
  const workerVersion = await getCurrentSessionWorkerVersion(project.session_id);

  if (workerVersion === 'v2') {
    const client = createAppBuilderCloudAgentNextClient(authToken);
    return client.interruptSession(project.session_id);
  } else {
    const client = createAppBuilderCloudAgentClient(authToken);
    return client.interruptSession(project.session_id);
  }
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
): Promise<InitiateSessionV2Output | InitiateSessionV2OutputNext> {
  const { projectId, owner, authToken } = input;

  const project = await getProjectWithOwnershipCheck(projectId, owner);

  if (!project.session_id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Project session not prepared',
    });
  }

  const workerVersion = await getCurrentSessionWorkerVersion(project.session_id);

  if (workerVersion === 'v2') {
    // V2: use cloud-agent-next
    const client = createAppBuilderCloudAgentNextClient(authToken);
    const sessionState = await client.getSession(project.session_id);

    if (sessionState.initiatedAt) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Session already initiated.',
      });
    }

    const result = await client.initiateFromPreparedSession({
      cloudAgentSessionId: project.session_id,
    });

    return {
      cloudAgentSessionId: result.cloudAgentSessionId,
      executionId: result.executionId,
      status: result.status,
      streamUrl: result.streamUrl,
    };
  } else {
    // V1: use old cloud-agent
    const client = createAppBuilderCloudAgentClient(authToken);
    const existingSession = await client.getSession(project.session_id);

    if (existingSession.initiatedAt) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Session already initiated.',
      });
    }

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
}

/**
 * Send a message to an existing App Builder session using the WebSocket-based API.
 * Returns immediately with session info - client connects to WebSocket separately for events.
 *
 * If the project was migrated to GitHub but the session still uses the internal git URL,
 * a new session is created with the GitHub repo. The frontend will receive a different
 * cloudAgentSessionId and should reconnect to the new session's WebSocket.
 */
export async function sendMessage(
  input: SendMessageInput
): Promise<InitiateSessionV2Output | InitiateSessionV2OutputNext> {
  const { projectId, owner, message, authToken, images, model } = input;

  const project = await getProjectWithOwnershipCheck(projectId, owner);

  if (!project.session_id) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Project not found',
    });
  }

  const currentSessionId = project.session_id;

  // Determine which model to use - prefer override, fallback to project's stored model
  const effectiveModel = model ?? project.model_id;

  // If model changed, update the project's model_id
  if (model && model !== project.model_id) {
    await db
      .update(app_builder_projects)
      .set({ model_id: model })
      .where(eq(app_builder_projects.id, projectId));
  }

  // Determine current and required worker versions
  const currentWorkerVersion = await getCurrentSessionWorkerVersion(currentSessionId);
  const requiredWorkerVersion = await getRequiredWorkerVersion();

  // Auto-upgrade: current session is v1 but flag requires v2
  if (currentWorkerVersion === 'v1' && requiredWorkerVersion === 'v2') {
    const v2Client = createAppBuilderCloudAgentNextClient(authToken);
    const gitUrl = getProjectGitUrl(projectId);

    // Determine git params based on whether project is on GitHub
    let prepareParams: Parameters<typeof v2Client.prepareSession>[0];

    if (project.git_repo_full_name) {
      prepareParams = {
        githubRepo: project.git_repo_full_name,
        prompt: message,
        mode: 'build',
        model: effectiveModel,
        upstreamBranch: 'main',
        autoCommit: true,
        setupCommands: ['bun install'],
        kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
        images,
        appendSystemPrompt: APP_BUILDER_APPEND_SYSTEM_PROMPT,
      };
    } else {
      const { token: gitToken } = await appBuilderClient.generateGitToken(projectId, 'full');
      prepareParams = {
        gitUrl,
        gitToken,
        prompt: message,
        mode: 'build',
        model: effectiveModel,
        upstreamBranch: 'main',
        autoCommit: true,
        setupCommands: ['bun install'],
        kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
        images,
        appendSystemPrompt: APP_BUILDER_APPEND_SYSTEM_PROMPT,
      };
    }

    const { cloudAgentSessionId: newSessionId } = await v2Client.prepareSession(prepareParams);

    const result = await v2Client.initiateFromPreparedSession({
      cloudAgentSessionId: newSessionId,
    });

    // Atomically end old session, update project, and record new session
    await db.transaction(async tx => {
      await tx
        .update(app_builder_project_sessions)
        .set({ ended_at: sql`now()` })
        .where(eq(app_builder_project_sessions.cloud_agent_session_id, currentSessionId));

      await tx
        .update(app_builder_projects)
        .set({ session_id: newSessionId })
        .where(eq(app_builder_projects.id, projectId));

      await tx.insert(app_builder_project_sessions).values({
        project_id: projectId,
        cloud_agent_session_id: newSessionId,
        reason: AppBuilderSessionReason.Upgrade,
        worker_version: 'v2',
      });
    });

    return {
      cloudAgentSessionId: newSessionId,
      executionId: result.executionId,
      status: result.status,
      streamUrl: result.streamUrl,
    };
  }

  // V2 session: use cloud-agent-next
  if (currentWorkerVersion === 'v2') {
    const v2Client = createAppBuilderCloudAgentNextClient(authToken);

    // Generate git token for non-migrated projects
    let gitToken: string | undefined;
    if (!project.git_repo_full_name) {
      const tokenResult = await appBuilderClient.generateGitToken(projectId, 'full');
      gitToken = tokenResult.token;
    }

    const result = await v2Client.sendMessage({
      cloudAgentSessionId: project.session_id,
      prompt: message,
      mode: 'build',
      model: effectiveModel,
      autoCommit: true,
      gitToken,
      images,
    });

    return {
      cloudAgentSessionId: result.cloudAgentSessionId,
      executionId: result.executionId,
      status: result.status,
      streamUrl: result.streamUrl,
    };
  }

  // V1 session: use old cloud-agent
  const client = createAppBuilderCloudAgentClient(authToken);

  // Handle GitHub migration path for v1 sessions
  if (project.git_repo_full_name) {
    const session = await client.getSession(project.session_id);

    if (session.gitUrl && !session.githubRepo) {
      const { cloudAgentSessionId: newSessionId } = await client.prepareSession({
        githubRepo: project.git_repo_full_name,
        prompt: message,
        mode: 'code',
        model: effectiveModel,
        upstreamBranch: 'main',
        autoCommit: true,
        setupCommands: ['bun install'],
        kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
        images,
        appendSystemPrompt: APP_BUILDER_APPEND_SYSTEM_PROMPT,
        createdOnPlatform: 'app-builder',
      });

      const result = await client.initiateFromKilocodeSessionV2({
        cloudAgentSessionId: newSessionId,
      });

      await db.transaction(async tx => {
        await tx
          .update(app_builder_project_sessions)
          .set({ ended_at: sql`now()` })
          .where(eq(app_builder_project_sessions.cloud_agent_session_id, currentSessionId));

        await tx
          .update(app_builder_projects)
          .set({ session_id: newSessionId })
          .where(eq(app_builder_projects.id, projectId));

        await tx.insert(app_builder_project_sessions).values({
          project_id: projectId,
          cloud_agent_session_id: newSessionId,
          reason: AppBuilderSessionReason.GitHubMigration,
          worker_version: 'v1',
        });
      });

      return {
        cloudAgentSessionId: newSessionId,
        executionId: result.executionId,
        status: result.status,
        streamUrl: result.streamUrl,
      };
    }
  }

  // Non-migrated v1 project - use existing flow
  let gitToken: string | undefined;
  if (!project.git_repo_full_name) {
    const tokenResult = await appBuilderClient.generateGitToken(projectId, 'full');
    gitToken = tokenResult.token;
  }

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

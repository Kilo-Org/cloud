import 'server-only';
import type { Owner } from '@/lib/integrations/core/types';
import {
  createAppBuilderCloudAgentNextClient,
  type InterruptResult,
  type InitiateSessionOutput,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import * as appBuilderClient from '@/lib/app-builder/app-builder-client';
import { APP_BUILDER_APPEND_SYSTEM_PROMPT } from '@/lib/app-builder/constants';
import { db } from '@/lib/drizzle';
import {
  app_builder_projects,
  app_builder_project_sessions,
  AppBuilderSessionReason,
  cliSessions,
  cli_sessions_v2,
} from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { eq, and, sql, asc } from 'drizzle-orm';
import type { CloudMessage } from '@/components/cloud-agent/types';
import { APP_BUILDER_URL } from '@/lib/config.server';
import { createDeployment, getDeployment } from '@/lib/user-deployments/deployments-service';
import type { DeploymentSource } from '@/lib/user-deployments/types';
import { getHistoricalMessages } from '@/lib/app-builder/historical-messages';
import type { Images } from '@/lib/images-schema';
import { generateImageMCPToken } from '@/lib/app-builder/image-mcp-token';
import { buildImageContextFromAttachments } from '@/lib/app-builder/image-context';
import { deleteProjectAssets } from '@/lib/r2/app-builder-assets';
import { getEnvVariable } from '@/lib/dotenvx';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';
import { encryptWithPublicKey, type EncryptedEnvelope } from '@/lib/encryption';
import { modelSupportsImages } from '@/lib/ai-gateway/providers/model-capabilities';
import { errorExceptInTest } from '@/lib/utils.server';

import type {
  AppBuilderProject,
  CreateProjectInput,
  CreateProjectResult,
  StartSessionInput,
  SendMessageInput,
  SendMessageResult,
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

const REQUIRED_WORKER_VERSION = 'v2' satisfies WorkerVersion;

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
      v1_title: cliSessions.title,
      v2_title: cli_sessions_v2.title,
    })
    .from(app_builder_project_sessions)
    .leftJoin(
      cliSessions,
      eq(app_builder_project_sessions.cloud_agent_session_id, cliSessions.cloud_agent_session_id)
    )
    .leftJoin(
      cli_sessions_v2,
      eq(
        app_builder_project_sessions.cloud_agent_session_id,
        cli_sessions_v2.cloud_agent_session_id
      )
    )
    .where(eq(app_builder_project_sessions.project_id, projectId))
    .orderBy(asc(app_builder_project_sessions.created_at));

  return rows.map(row => ({
    id: row.id,
    cloud_agent_session_id: row.cloud_agent_session_id,
    worker_version: parseWorkerVersion(row.worker_version) ?? 'v1',
    ended_at: row.ended_at,
    title: row.v1_title ?? row.v2_title ?? null,
    initiated: null,
    prepared: null,
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

type NewSessionDecision =
  | { createNew: false }
  | {
      createNew: true;
      reason: 'upgrade' | 'github_migration' | 'model_vision_change';
    };

async function shouldCreateNewSession(
  project: AppBuilderProject,
  currentSessionId: string,
  currentWorkerVersion: WorkerVersion,
  authToken: string,
  currentModelId: string,
  newModelId: string
): Promise<NewSessionDecision> {
  if (currentWorkerVersion !== REQUIRED_WORKER_VERSION) {
    return { createNew: true, reason: 'upgrade' };
  }

  if (project.git_repo_full_name) {
    const session =
      await createAppBuilderCloudAgentNextClient(authToken).getSession(currentSessionId);

    if (session.gitUrl && !session.githubRepo) {
      return {
        createNew: true,
        reason: 'github_migration',
      };
    }
  }

  if (currentModelId !== newModelId) {
    const [currentSupportsImages, newSupportsImages] = await Promise.all([
      modelSupportsImages(currentModelId),
      modelSupportsImages(newModelId),
    ]);
    if (currentSupportsImages !== newSupportsImages) {
      return {
        createNew: true,
        reason: 'model_vision_change',
      };
    }
  }

  return { createNew: false };
}

function buildMCPServersConfig(params: {
  userId: string;
  projectId: string;
  owner: Owner;
}):
  | Record<string, { type: 'remote'; url: string; headers: Record<string, EncryptedEnvelope> }>
  | undefined {
  const mcpUrl = getEnvVariable('CLOUD_AGENT_IMAGES_MCP_URL');
  if (!mcpUrl) return undefined;
  if (!AGENT_ENV_VARS_PUBLIC_KEY) {
    console.error('AGENT_ENV_VARS_PUBLIC_KEY not configured; cannot encrypt MCP headers');
    return undefined;
  }

  try {
    const token = generateImageMCPToken(params);
    const publicKey = Buffer.from(AGENT_ENV_VARS_PUBLIC_KEY, 'base64');
    return {
      'app-builder-images': {
        type: 'remote',
        url: mcpUrl,
        headers: {
          Authorization: encryptWithPublicKey(`Bearer ${token}`, publicKey),
        },
      },
    };
  } catch (error) {
    console.error('Failed to build MCP servers config:', error);
    return undefined;
  }
}

type CreateSessionParams = {
  projectId: string;
  currentSessionId: string;
  createdByUserId: string;
  owner: Owner;
  message: string;
  model: string;
  authToken: string;
  gitRepoFullName: string | null;
  images?: Images;
  reason: 'upgrade' | 'github_migration' | 'model_vision_change' | 'user_initiated';
};

function toSessionReason(reason: CreateSessionParams['reason']): string {
  if (reason === 'upgrade') return AppBuilderSessionReason.Upgrade;
  if (reason === 'github_migration') return AppBuilderSessionReason.GitHubMigration;
  if (reason === 'model_vision_change') return AppBuilderSessionReason.ModelVisionChange;
  if (reason === 'user_initiated') return AppBuilderSessionReason.UserInitiated;
  reason satisfies never;
  throw new Error(`Unhandled session reason: ${reason}`);
}

async function createCloudAgentNextSession(
  params: CreateSessionParams
): Promise<InitiateSessionOutput> {
  const {
    projectId,
    currentSessionId,
    createdByUserId,
    owner,
    message,
    model,
    authToken,
    gitRepoFullName,
    images,
    reason,
  } = params;
  const client = createAppBuilderCloudAgentNextClient(authToken);

  const augmentedMessage = message + buildImageContextFromAttachments(images);

  let prepareParams: Parameters<typeof client.prepareSession>[0];
  if (gitRepoFullName) {
    prepareParams = {
      githubRepo: gitRepoFullName,
      prompt: augmentedMessage,
      mode: 'build',
      model,
      upstreamBranch: 'main',
      autoCommit: true,
      setupCommands: ['bun install'],
      kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
      images,
      appendSystemPrompt: APP_BUILDER_APPEND_SYSTEM_PROMPT,
      mcpServers: buildMCPServersConfig({ userId: createdByUserId, projectId, owner }),
      createdOnPlatform: 'app-builder',
    };
  } else {
    const { token: gitToken } = await appBuilderClient.generateGitToken(projectId, 'full');
    prepareParams = {
      gitUrl: getProjectGitUrl(projectId),
      gitToken,
      prompt: augmentedMessage,
      mode: 'build',
      model,
      upstreamBranch: 'main',
      autoCommit: true,
      setupCommands: ['bun install'],
      kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
      images,
      appendSystemPrompt: APP_BUILDER_APPEND_SYSTEM_PROMPT,
      mcpServers: buildMCPServersConfig({ userId: createdByUserId, projectId, owner }),
      createdOnPlatform: 'app-builder',
    };
  }

  const { cloudAgentSessionId: newSessionId } = await client.prepareSession(prepareParams);

  const result = await client.initiateFromPreparedSession({
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
      reason: toSessionReason(reason),
      worker_version: REQUIRED_WORKER_VERSION,
    });
  });

  return {
    cloudAgentSessionId: newSessionId,
    executionId: result.executionId,
    status: result.status,
    streamUrl: result.streamUrl,
    messageId: result.messageId,
    delivery: result.delivery,
  };
}

type SendToExistingSessionParams = {
  projectId: string;
  sessionId: string;
  message: string;
  model: string;
  authToken: string;
  gitRepoFullName: string | null;
  images?: Images;
};

async function sendToExistingCloudAgentNextSession(
  params: SendToExistingSessionParams
): Promise<InitiateSessionOutput> {
  const { projectId, sessionId, message, model, authToken, gitRepoFullName, images } = params;

  const imageContext = buildImageContextFromAttachments(images);

  let gitToken: string | undefined;
  if (!gitRepoFullName) {
    const tokenResult = await appBuilderClient.generateGitToken(projectId, 'full');
    gitToken = tokenResult.token;
  }

  const client = createAppBuilderCloudAgentNextClient(authToken);
  const result = await client.sendMessage({
    cloudAgentSessionId: sessionId,
    payload: {
      type: 'prompt',
      prompt: message + imageContext,
      mode: 'code',
      model,
    },
    autoCommit: true,
    gitToken,
    images,
  });

  return {
    cloudAgentSessionId: result.cloudAgentSessionId,
    executionId: result.executionId,
    status: result.status,
    streamUrl: result.streamUrl,
    messageId: result.messageId,
    delivery: result.delivery,
  };
}

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

    const gitUrl = getProjectGitUrl(projectId);
    const { token: gitToken } = await appBuilderClient.generateGitToken(projectId, 'full');

    const sharedParams = {
      gitUrl,
      gitToken,
      prompt: prompt + buildImageContextFromAttachments(images),
      model,
      upstreamBranch: 'main' as const,
      autoCommit: true,
      setupCommands: ['bun install'],
      kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
      images,
      appendSystemPrompt: APP_BUILDER_APPEND_SYSTEM_PROMPT,
      createdOnPlatform: 'app-builder',
    };

    const client = createAppBuilderCloudAgentNextClient(authToken);
    const { cloudAgentSessionId } = await client.prepareSession({
      ...sharedParams,
      mode: mode === 'ask' ? 'plan' : 'build',
      mcpServers: buildMCPServersConfig({ userId: createdByUserId, projectId, owner }),
    });

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
        worker_version: REQUIRED_WORKER_VERSION,
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
 * Fetches session state from cloud-agent-next to determine if session needs to be initiated.
 *
 * Cloud-agent-next sessions replay messages over WebSocket. Legacy cloud-agent messages
 * are read from R2 via cli_sessions and are never routed back to the legacy worker.
 */
export async function getProject(
  projectId: string,
  owner: Owner,
  authToken: string
): Promise<ProjectWithMessages> {
  const project = await getProjectWithOwnershipCheck(projectId, owner);

  // Fetch all sessions for this project
  const sessions = await getProjectSessions(projectId);

  // Session state for the active session (populated below).
  // Messages are only eagerly loaded for the active session; ended legacy v1
  // sessions load their messages lazily via getLegacySessionMessages when the
  // user expands them in the UI.
  let sessionInitiated: boolean | null = null;
  let sessionPrepared: boolean | null = null;
  let messages: CloudMessage[] = [];

  if (project.session_id) {
    const activeSession = sessions.find(s => s.cloud_agent_session_id === project.session_id);

    if (activeSession?.worker_version === REQUIRED_WORKER_VERSION) {
      try {
        const client = createAppBuilderCloudAgentNextClient(authToken);
        const sessionState = await client.getSession(project.session_id);

        sessionPrepared = sessionState.preparedAt != null;
        sessionInitiated = sessionState.initiatedAt != null;

        if (sessionInitiated === false && sessionState.prompt) {
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
      } catch (err) {
        errorExceptInTest(
          'Failed to load cloud-agent-next session state for App Builder project',
          { cloudAgentSessionId: project.session_id, projectId },
          err
        );
        sessionInitiated = null;
        sessionPrepared = null;
      }
    } else if (activeSession) {
      // Active session is a legacy v1 session — fetch its messages from R2 so
      // the user sees history immediately. Ended v1 sessions are loaded lazily.
      try {
        messages = await getHistoricalMessages(project.session_id);
      } catch (err) {
        errorExceptInTest(
          'Failed to load historical messages for active legacy App Builder session',
          { cloudAgentSessionId: project.session_id, projectId },
          err
        );
      }
    }
  }

  // Annotate the active session with initiated/prepared state from the DO.
  // Ended sessions keep initiated/prepared as null.
  const annotatedSessions = sessions.map(s => {
    const isActiveSession = project.session_id && s.cloud_agent_session_id === project.session_id;
    return {
      ...s,
      initiated: isActiveSession ? sessionInitiated : null,
      prepared: isActiveSession ? sessionPrepared : null,
    };
  });

  return {
    ...project,
    messages,
    sessions: annotatedSessions,
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
  const project = await getProjectWithOwnershipCheck(projectId, owner);

  // Only delete public assets if there's no deployment — deployed sites reference these images
  if (!project.deployment_id) {
    await deleteProjectAssets(projectId, owner).catch(err => {
      console.error('Failed to delete project assets from R2:', err);
    });
  }

  await appBuilderClient.deleteProject(projectId);
  await db.delete(app_builder_projects).where(eq(app_builder_projects.id, projectId));
}

/**
 * Fetch historical messages for a legacy v1 session belonging to the given project.
 *
 * Ended legacy sessions are no longer streamed from the Durable Object — their messages
 * live in R2 via `cli_sessions`. This endpoint is called lazily by the client when the
 * user expands a past session in the UI, so we don't pay the R2 cost for every session
 * on every project load.
 */
export async function getLegacySessionMessages(
  projectId: string,
  cloudAgentSessionId: string,
  owner: Owner
): Promise<CloudMessage[]> {
  await getProjectWithOwnershipCheck(projectId, owner);

  const [row] = await db
    .select({ worker_version: app_builder_project_sessions.worker_version })
    .from(app_builder_project_sessions)
    .where(
      and(
        eq(app_builder_project_sessions.project_id, projectId),
        eq(app_builder_project_sessions.cloud_agent_session_id, cloudAgentSessionId)
      )
    )
    .limit(1);

  if (!row) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Session not found for this project',
    });
  }

  if (parseWorkerVersion(row.worker_version) === REQUIRED_WORKER_VERSION) {
    // v2 sessions stream from cloud-agent-next; no R2 history exists for them.
    return [];
  }

  return getHistoricalMessages(cloudAgentSessionId);
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

  const workerVersion = await getCurrentSessionWorkerVersion(project.session_id);
  if (workerVersion !== REQUIRED_WORKER_VERSION) {
    return {
      success: false,
      message: 'Legacy App Builder session has no cloud-agent-next execution to interrupt.',
      processesFound: false,
    };
  }

  const client = createAppBuilderCloudAgentNextClient(authToken);
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
): Promise<InitiateSessionOutput> {
  const { projectId, owner, authToken } = input;

  const project = await getProjectWithOwnershipCheck(projectId, owner);

  if (!project.session_id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Project session not prepared',
    });
  }

  const workerVersion = await getCurrentSessionWorkerVersion(project.session_id);
  if (workerVersion !== REQUIRED_WORKER_VERSION) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Legacy App Builder sessions must be upgraded before streaming.',
    });
  }

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
    messageId: result.messageId,
    delivery: result.delivery,
  };
}

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const { projectId, owner, message, authToken, images, model, forceNewSession } = input;

  const project = await getProjectWithOwnershipCheck(projectId, owner);

  if (!project.session_id) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Project not found',
    });
  }

  const currentSessionId = project.session_id;
  const effectiveModel = model ?? project.model_id;

  if (model && model !== project.model_id) {
    await db
      .update(app_builder_projects)
      .set({ model_id: model })
      .where(eq(app_builder_projects.id, projectId));
  }

  const currentWorkerVersion = await getCurrentSessionWorkerVersion(currentSessionId);

  // When forceNewSession is true, bypass the automatic session-change logic and
  // create a new session immediately with reason 'user_initiated'.
  if (forceNewSession) {
    const createParams = {
      projectId,
      currentSessionId,
      createdByUserId: project.created_by_user_id ?? owner.id,
      owner,
      message,
      model: effectiveModel,
      authToken,
      gitRepoFullName: project.git_repo_full_name,
      images,
      reason: 'user_initiated' as const,
    } satisfies CreateSessionParams;

    const result = await createCloudAgentNextSession(createParams);

    return {
      cloudAgentSessionId: result.cloudAgentSessionId,
      workerVersion: REQUIRED_WORKER_VERSION,
    };
  }

  const decision = await shouldCreateNewSession(
    project,
    currentSessionId,
    currentWorkerVersion ?? 'v1',
    authToken,
    project.model_id,
    effectiveModel
  );

  if (decision.createNew) {
    const createParams = {
      projectId,
      currentSessionId,
      createdByUserId: project.created_by_user_id ?? owner.id,
      owner,
      message,
      model: effectiveModel,
      authToken,
      gitRepoFullName: project.git_repo_full_name,
      images,
      reason: decision.reason,
    } satisfies CreateSessionParams;

    const result = await createCloudAgentNextSession(createParams);

    return {
      cloudAgentSessionId: result.cloudAgentSessionId,
      workerVersion: REQUIRED_WORKER_VERSION,
    };
  }

  const sendParams = {
    projectId,
    sessionId: currentSessionId,
    message,
    model: effectiveModel,
    authToken,
    gitRepoFullName: project.git_repo_full_name,
    images,
  } satisfies SendToExistingSessionParams;

  const result = await sendToExistingCloudAgentNextSession(sendParams);

  return {
    cloudAgentSessionId: result.cloudAgentSessionId,
    workerVersion: REQUIRED_WORKER_VERSION,
  };
}

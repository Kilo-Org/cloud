import type { Owner } from '@/lib/integrations/core/types';
import type { CloudMessage } from '@/components/cloud-agent/types';
import type { app_builder_projects } from '@/db/schema';
import type { Images } from '@/lib/images-schema';
import type { AppBuilderGalleryTemplate } from '@/lib/app-builder/constants';

export type AppBuilderProject = typeof app_builder_projects.$inferSelect;

/**
 * Input for creating a new project
 */
export type CreateProjectInput = {
  owner: Owner;
  prompt: string;
  model: string;
  title?: string;
  createdByUserId: string;
  authToken: string;
  images?: Images;
  template?: AppBuilderGalleryTemplate;
  /** Mode for the cloud agent session. Defaults to 'code' */
  mode?: 'code' | 'ask';
};

/**
 * Result of creating a project
 */
export type CreateProjectResult = {
  projectId: string;
};

/**
 * Input for starting a session for an existing project
 */
export type StartSessionInput = {
  projectId: string;
  owner: Owner;
  authToken: string;
};

/**
 * Input for sending a message to an existing session
 */
export type SendMessageInput = {
  projectId: string;
  owner: Owner;
  message: string;
  authToken: string;
  images?: Images;
  /** Optional model override - if provided, updates the project's model_id */
  model?: string;
};

/**
 * Result of sendMessage — includes the worker version of the session that handled
 * the message, so the client can distinguish upgrades from GitHub migrations.
 */
export type SendMessageResult = {
  cloudAgentSessionId: string;
  workerVersion: WorkerVersion;
};

/**
 * Worker version for cloud agent sessions
 */
export type WorkerVersion = 'v1' | 'v2';

/**
 * Session info returned with project data.
 * `initiated` and `prepared` are only populated for the active session
 * (the one fetched from the cloud-agent DO). Ended sessions have both as null.
 *
 * Used in ProjectManager.buildSessions() for routing decisions; not stored on sessions.
 */
export type ProjectSessionInfo = {
  id: string;
  cloud_agent_session_id: string;
  worker_version: WorkerVersion;
  ended_at: string | null;
  title: string | null;
  /**
   * Whether the cloud agent session has been initiated (agent started executing).
   * - false: Session is prepared but not yet initiated (need to call startSessionForProject)
   * - true: Session has been initiated
   * - null: Ended session, unknown, or error state
   */
  initiated: boolean | null;
  /**
   * Whether the cloud agent session has been prepared (DO has state stored).
   * - false: Legacy session — DO has no state, needs prepareLegacySession before messaging
   * - true: Session is prepared and can use WebSocket-based messaging
   * - null: Ended session, unknown, or error state
   */
  prepared: boolean | null;
};

/**
 * Subset of session info exposed on SessionBase for UI display and identity.
 * Routing-only fields (worker_version, initiated, prepared) are consumed in
 * buildSessions() and not stored on the session object.
 */
export type SessionDisplayInfo = {
  id: string;
  cloud_agent_session_id: string | null;
  ended_at: string | null;
  title: string | null;
};

/**
 * Result of deploying a project
 */
export type DeployProjectResult =
  | { success: true; deploymentId: string; deploymentUrl: string; alreadyDeployed: boolean }
  | { success: false; error: 'payment_required' | 'invalid_slug' | 'slug_taken'; message: string };

/**
 * Project with all its messages and session state.
 * Session-level initiated/prepared state lives on each ProjectSessionInfo.
 */
export type ProjectWithMessages = AppBuilderProject & {
  messages: CloudMessage[];
  /** All sessions for this project, ordered by created_at ascending */
  sessions: ProjectSessionInfo[];
};

/**
 * Input for migrating a project to GitHub
 * User-created repository approach: users create empty repos themselves, we push to them
 */
export type MigrateToGitHubInput = {
  projectId: string;
  owner: Owner;
  /** Kilo user ID - needed by preview DO to resolve GitHub tokens */
  userId: string;
  repoFullName: string; // e.g., "org/my-repo" - user-created repo
};

/**
 * Result of migrating a project to GitHub
 */
export type MigrateToGitHubResult =
  | { success: true; githubRepoUrl: string; newSessionId: string }
  | { success: false; error: MigrateToGitHubErrorCode };

export type MigrateToGitHubErrorCode =
  | 'github_app_not_installed'
  | 'already_migrated'
  | 'repo_not_found' // Specified repo doesn't exist or not accessible
  | 'repo_not_empty' // Repo has commits, must be empty
  | 'push_failed'
  | 'project_not_found'
  | 'internal_error';

/**
 * Repository info returned by canMigrateToGitHub
 */
export type AvailableRepo = {
  fullName: string;
  createdAt: string;
  isPrivate: boolean;
};

/**
 * Pre-flight check result for GitHub migration
 * User-created repository approach: returns info needed to guide user through creating repo
 */
export type CanMigrateToGitHubResult = {
  /** Whether the owner has a GitHub App installation */
  hasGitHubIntegration: boolean;
  /** The GitHub account login where the repo should be created */
  targetAccountName: string | null;
  /** Whether this project has already been migrated */
  alreadyMigrated: boolean;
  /** Suggested repository name based on project title */
  suggestedRepoName: string;
  /** URL to create new repo on GitHub (opens GitHub's new repo page) */
  newRepoUrl: string;
  /** URL to manage GitHub App repo access (for users with selective repo access) */
  installationSettingsUrl: string;
  /** List of repos accessible to the GitHub App installation */
  availableRepos: AvailableRepo[];
  /** Whether the GitHub App has access to all repos ('all') or only selected repos ('selected') */
  repositorySelection: 'all' | 'selected';
};

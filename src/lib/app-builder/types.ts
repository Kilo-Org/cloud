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
 * Result of deploying a project
 */
export type DeployProjectResult =
  | { success: true; deploymentId: string; deploymentUrl: string; alreadyDeployed: boolean }
  | { success: false; error: 'payment_required' | 'invalid_slug' | 'slug_taken'; message: string };

/**
 * Project with all its messages and session state
 */
export type ProjectWithMessages = AppBuilderProject & {
  messages: CloudMessage[];
  /**
   * Whether the cloud agent session has been initiated (already started streaming).
   * - false: Session is prepared but not yet initiated (need to call startSessionForProject)
   * - true: Session has been initiated and has received AI responses
   * - null: No session exists (legacy project or error state)
   */
  sessionInitiated: boolean | null;
  /**
   * Whether the cloud agent session has been prepared (DO has state stored).
   * - false: Legacy session - DO has no state, needs prepareLegacySession before messaging
   * - true: Session is prepared and can use WebSocket-based messaging
   * - null: No session exists or error state
   *
   * Legacy sessions (preparedAt is null) have their messages fetched from R2 instead
   * of WebSocket replay.
   */
  sessionPrepared: boolean | null;
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

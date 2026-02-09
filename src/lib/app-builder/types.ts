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

import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  validateGitHubRepoAccessForUser,
  validateGitHubRepoAccessForOrganization,
  getGitHubInstallationIdForOrganization,
  getGitHubInstallationIdForUser,
} from '@/lib/cloud-agent/github-integration-helpers';
import {
  getGitLabTokenForUser,
  getGitLabTokenForOrganization,
  validateGitLabRepoAccessForUser,
  validateGitLabRepoAccessForOrganization,
  buildGitLabCloneUrl,
  getGitLabInstanceUrlForUser,
  getGitLabInstanceUrlForOrganization,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import { createCloudAgentClient } from '@/lib/cloud-agent/cloud-agent-client';
import { generateApiToken } from '@/lib/tokens';
import { publicPrepareSessionSchema } from './schema';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner } from '@/lib/agent/types';
import type { EncryptedEnvelope } from '@/lib/encryption';
import { signStreamTicket } from '@/lib/cloud-agent/stream-ticket';
import {
  mergeProfileConfiguration,
  ProfileNotFoundError,
} from '@/lib/agent/profile-session-config';

function handleTRPCError(error: unknown): NextResponse {
  if (error instanceof TRPCError) {
    const statusCode = error.code === 'UNAUTHORIZED' ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status: statusCode });
  }

  captureException(error, {
    tags: { source: 'cloud-agent-prepare-session' },
  });
  return NextResponse.json({ error: 'An unexpected error occurred' }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

    if (authFailedResponse) {
      return authFailedResponse;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
    }

    const validation = publicPrepareSessionSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: validation.error.issues.map(issue => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        { status: 400 }
      );
    }

    const input = validation.data;

    let githubInstallationId: string | undefined;
    let kilocodeOrganizationId: string | undefined;

    // Validate organization access if provided
    if (input.organizationId) {
      // Verify org membership before proceeding
      await ensureOrganizationAccess({ user }, input.organizationId);
      githubInstallationId = await getGitHubInstallationIdForOrganization(input.organizationId);
      kilocodeOrganizationId = input.organizationId;
    } else {
      githubInstallationId = await getGitHubInstallationIdForUser(user.id);
    }

    // Determine which platform we're using and get the appropriate token/validation
    let gitUrl: string | undefined;
    let gitToken: string | undefined;
    let repoIdentifier: string; // For error messages

    if (input.githubRepo) {
      // GitHub flow - we pass githubInstallationId to cloud-agent which generates tokens
      repoIdentifier = input.githubRepo;

      const hasRepoAccess = input.organizationId
        ? await validateGitHubRepoAccessForOrganization(input.organizationId, input.githubRepo)
        : await validateGitHubRepoAccessForUser(user.id, input.githubRepo);

      if (!hasRepoAccess) {
        return NextResponse.json(
          {
            error: 'Repository not found or not accessible',
            details: [
              {
                path: 'githubRepo',
                message: `You do not have access to the repository '${input.githubRepo}'. Please ensure the GitHub integration has access to this repository.`,
              },
            ],
          },
          { status: 404 }
        );
      }
    } else if (input.gitlabProject) {
      // GitLab flow
      repoIdentifier = input.gitlabProject;

      gitToken = input.organizationId
        ? await getGitLabTokenForOrganization(input.organizationId)
        : await getGitLabTokenForUser(user.id);

      if (!gitToken) {
        return NextResponse.json(
          {
            error: 'GitLab integration not configured',
            details: [
              {
                path: 'gitlabProject',
                message: 'No GitLab integration found. Please connect your GitLab account first.',
              },
            ],
          },
          { status: 400 }
        );
      }

      const hasRepoAccess = input.organizationId
        ? await validateGitLabRepoAccessForOrganization(input.organizationId, input.gitlabProject)
        : await validateGitLabRepoAccessForUser(user.id, input.gitlabProject);

      if (!hasRepoAccess) {
        return NextResponse.json(
          {
            error: 'Project not found or not accessible',
            details: [
              {
                path: 'gitlabProject',
                message: `You do not have access to the project '${input.gitlabProject}'. Please ensure the GitLab integration has access to this project.`,
              },
            ],
          },
          { status: 404 }
        );
      }

      // Build the GitLab clone URL
      const instanceUrl = input.organizationId
        ? await getGitLabInstanceUrlForOrganization(input.organizationId)
        : await getGitLabInstanceUrlForUser(user.id);

      gitUrl = buildGitLabCloneUrl(input.gitlabProject, instanceUrl);
    } else {
      // This shouldn't happen due to schema validation, but handle it gracefully
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: [
            {
              path: 'githubRepo',
              message: 'Must provide either githubRepo or gitlabProject',
            },
          ],
        },
        { status: 400 }
      );
    }

    let mergedEnvVars: Record<string, string> | undefined;
    let mergedSetupCommands: string[] | undefined;
    let encryptedSecrets: Record<string, EncryptedEnvelope> | undefined;

    try {
      const owner: ProfileOwner = input.organizationId
        ? { type: 'organization', id: input.organizationId }
        : { type: 'user', id: user.id };

      const merged = await mergeProfileConfiguration({
        profileName: input.profileName,
        owner,
        // In org context, pass userId to enable fallback to personal profiles
        userId: input.organizationId ? user.id : undefined,
        envVars: input.envVars,
        setupCommands: input.setupCommands,
      });

      mergedEnvVars = merged.envVars;
      mergedSetupCommands = merged.setupCommands;
      encryptedSecrets = merged.encryptedSecrets;
    } catch (error) {
      if (error instanceof ProfileNotFoundError) {
        return NextResponse.json(
          {
            error: 'Profile not found',
            details: [
              {
                path: 'profileName',
                message: error.message,
              },
            ],
          },
          { status: 404 }
        );
      }
      throw error;
    }

    try {
      const authToken = generateApiToken(user);
      const client = createCloudAgentClient(authToken);

      const result = await client.prepareSession({
        prompt: input.prompt,
        mode: input.mode,
        model: input.model,
        // GitHub-specific params (only set for GitHub repos)
        githubRepo: input.githubRepo,
        githubInstallationId,
        // GitLab-specific params (only set for GitLab projects)
        gitUrl,
        gitToken,
        // Platform detection: explicit instead of URL-based
        platform: input.gitlabProject ? 'gitlab' : 'github',
        // Common params
        kilocodeOrganizationId,
        envVars: mergedEnvVars,
        encryptedSecrets,
        setupCommands: mergedSetupCommands,
        mcpServers: input.mcpServers,
        autoCommit: input.autoCommit,
        upstreamBranch: input.upstreamBranch,
        callbackTarget: input.callbackTarget,
      });

      const ticketResult = signStreamTicket({
        userId: user.id,
        kiloSessionId: result.kiloSessionId,
        cloudAgentSessionId: result.cloudAgentSessionId,
        organizationId: input.organizationId,
      });

      return NextResponse.json({
        ...result,
        ...ticketResult,
      });
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-prepare-session', step: 'forward-to-cloud-agent' },
        extra: {
          userId: user.id,
          organizationId: input.organizationId,
          repo: repoIdentifier,
        },
      });

      // Allowlist approach: only pass through known safe error messages to avoid leaking
      // implementation details (e.g., "fetch failed", internal worker errors)
      if (error instanceof Error && error.message.includes('Insufficient credits')) {
        return NextResponse.json(
          { error: 'Insufficient credits. Please add funds to your account.' },
          { status: 402 }
        );
      }

      // All other errors get a generic message
      return NextResponse.json({ error: 'Failed to prepare session' }, { status: 500 });
    }
  } catch (error) {
    return handleTRPCError(error);
  }
}

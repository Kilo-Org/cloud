import {
  createCloudAgentNextClient,
  type AgentMode,
  type PrepareSessionInput,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { runSessionToCompletion, type RunSessionInput } from '@/lib/cloud-agent-next/run-session';
import {
  getGitHubTokenForOrganization,
  getGitHubTokenForUser,
} from '@/lib/cloud-agent/github-integration-helpers';
import {
  getGitLabTokenForOrganization,
  getGitLabTokenForUser,
  getGitLabInstanceUrlForOrganization,
  getGitLabInstanceUrlForUser,
  buildGitLabCloneUrl,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import type { PlatformIntegration } from '@kilocode/db';
import z from 'zod';

/**
 * Result from spawning a Cloud Agent session
 */
type SpawnCloudAgentResult = {
  response: string;
  sessionId?: string;
};

// Structured as a single object (not z.union) so the JSON schema has a top-level
// "type": "object", which Anthropic's tool API requires.
export const spawnCloudAgentInputSchema = z.object({
  githubRepo: z
    .string()
    .regex(/^[-a-zA-Z0-9_.]+\/[-a-zA-Z0-9_.]+$/)
    .describe('The GitHub repository in owner/repo format (e.g., "facebook/react")')
    .optional(),
  gitlabProject: z
    .string()
    .regex(/^[-a-zA-Z0-9_.]+(?:\/[-a-zA-Z0-9_.]+)+$/)
    .describe(
      'The GitLab project path in group/project format (e.g., "mygroup/myproject"). May include nested groups (e.g., "group/subgroup/project").'
    )
    .optional(),
  prompt: z
    .string()
    .describe(
      'The task description for the Cloud Agent. Be specific about what changes or analysis you want.'
    ),
  mode: z
    .enum(['code', 'ask'])
    .describe(
      'The agent mode: "code" for making changes (creates a PR/MR), "ask" for questions and explanations about existing code.'
    ),
});

type SpawnCloudAgentInput = z.infer<typeof spawnCloudAgentInputSchema>;

/**
 * Spawn a Cloud Agent session and collect the results.
 * Supports both GitHub (githubRepo) and GitLab (gitlabProject) repositories.
 * Delegates to the shared runSessionToCompletion helper.
 */
export default async function spawnCloudAgentSession(
  args: SpawnCloudAgentInput,
  model: string,
  platformIntegration: PlatformIntegration,
  authToken: string,
  ticketUserId: string,
  onSessionReady?: RunSessionInput['onSessionReady']
): Promise<SpawnCloudAgentResult> {
  console.log('[SlackBot] spawnCloudAgentSession called with args:', JSON.stringify(args, null, 2));

  // Build platform-specific prepareInput and initiateInput
  const kilocodeOrganizationId = platformIntegration.owned_by_organization_id || undefined;
  let prepareInput: PrepareSessionInput;
  let initiateInput: { githubToken?: string; kilocodeOrganizationId?: string };
  const mode: AgentMode = args.mode;

  if (!args.githubRepo && !args.gitlabProject) {
    return { response: 'Error: You must specify either a githubRepo or a gitlabProject.' };
  }

  const isGitLab = !!args.gitlabProject;
  const prompt =
    mode === 'code'
      ? args.prompt +
        (isGitLab
          ? '\n\nOpen a merge request with your changes and return the MR URL.'
          : '\n\nOpen a pull request with your changes and return the PR URL.')
      : args.prompt;

  if (args.gitlabProject) {
    // GitLab path: get token + instance URL, build clone URL, use gitUrl/gitToken
    const gitlabToken =
      typeof platformIntegration.owned_by_organization_id === 'string'
        ? await getGitLabTokenForOrganization(platformIntegration.owned_by_organization_id)
        : await getGitLabTokenForUser(platformIntegration.owned_by_user_id as string);

    if (!gitlabToken) {
      return {
        response:
          'Error: No GitLab token available. Please ensure a GitLab integration is connected in your Kilo Code settings.',
      };
    }

    const instanceUrl =
      typeof platformIntegration.owned_by_organization_id === 'string'
        ? await getGitLabInstanceUrlForOrganization(platformIntegration.owned_by_organization_id)
        : await getGitLabInstanceUrlForUser(platformIntegration.owned_by_user_id as string);

    const gitUrl = buildGitLabCloneUrl(args.gitlabProject, instanceUrl);

    const isSelfHosted = !/^https?:\/\/(www\.)?gitlab\.com(\/|$)/i.test(instanceUrl);
    console.log(
      '[SlackBot] GitLab session - project:',
      args.gitlabProject,
      'instance:',
      isSelfHosted ? 'self-hosted' : 'gitlab.com'
    );

    prepareInput = {
      prompt,
      mode,
      model,
      gitUrl,
      gitToken: gitlabToken,
      platform: 'gitlab',
      kilocodeOrganizationId,
      createdOnPlatform: 'slack',
    };
    initiateInput = { kilocodeOrganizationId };
  } else {
    // GitHub path: get token, use githubRepo/githubToken
    const githubToken =
      typeof platformIntegration.owned_by_organization_id === 'string'
        ? await getGitHubTokenForOrganization(platformIntegration.owned_by_organization_id)
        : await getGitHubTokenForUser(platformIntegration.owned_by_user_id as string);

    if (!githubToken) {
      return {
        response:
          'Error: No GitHub token available. Please ensure a GitHub integration is connected in your Kilo Code settings.',
      };
    }

    prepareInput = {
      githubRepo: args.githubRepo,
      prompt,
      mode,
      model,
      githubToken,
      kilocodeOrganizationId,
      createdOnPlatform: 'slack',
    };
    initiateInput = { githubToken, kilocodeOrganizationId };
  }

  const result = await runSessionToCompletion({
    client: createCloudAgentNextClient(authToken, { skipBalanceCheck: true }),
    prepareInput,
    initiateInput,
    ticketPayload: {
      userId: ticketUserId,
      organizationId: kilocodeOrganizationId,
    },
    logPrefix: '[KiloBot]',
    onSessionReady,
  });

  return { response: result.response, sessionId: result.sessionId };
}

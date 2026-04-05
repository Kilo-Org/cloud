import {
  createCloudAgentNextClient,
  type PrepareSessionInput,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { runSessionToCompletion } from '@/lib/cloud-agent-next/run-session';
import {
  getGitHubTokenForUser,
  getGitHubTokenForOrganization,
} from '@/lib/cloud-agent/github-integration-helpers';
import {
  getGitLabTokenForUser,
  getGitLabTokenForOrganization,
  getGitLabInstanceUrlForUser,
  getGitLabInstanceUrlForOrganization,
  buildGitLabCloneUrl,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import type OpenAI from 'openai';
import type { Owner } from '@/lib/integrations/core/types';
import {
  getInstallationByTeamId,
  getOwnerFromInstallation,
  getModel,
  getAccessTokenFromInstallation,
} from '@/lib/integrations/slack-service';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { runBot } from '@/lib/bots/core/run-bot';
import {
  formatGitHubRepositoriesForPrompt,
  getGitHubRepositoryContext,
} from '@/lib/slack-bot/github-repository-context';
import {
  formatGitLabRepositoriesForPrompt,
  getGitLabRepositoryContext,
} from '@/lib/slack-bot/gitlab-repository-context';
import {
  formatSlackConversationContextForPrompt,
  getSlackConversationContext,
  type SlackEventContext,
} from '@/lib/slack-bot/slack-channel-context';
import {
  getSlackUserEmailFromInstallation,
  getSlackUserDisplayAndRealName,
  getSlackMessagePermalink,
} from '@/lib/slack-bot/slack-utils';
import { getSlackbotAuthTokenForOwner } from '@/lib/slack/auth';
import { WebClient } from '@slack/web-api';

// Version string for API requests - must be >= 4.69.1 to pass version check
const SLACK_BOT_VERSION = '5.0.0';
const SLACK_BOT_USER_AGENT = `Kilo-Code/${SLACK_BOT_VERSION}`;

/**
 * Result from processing a Kilo Bot message, including metadata for logging
 */
export type KiloBotMessageResult = {
  response: string;
  modelUsed: string;
  toolCallsMade: string[];
  cloudAgentSessionId?: string;
  error?: string;
  installation: PlatformIntegration | null;
};

const KILO_BOT_SYSTEM_PROMPT = `You are Kilo Bot, a helpful AI assistant integrated into Slack.

## Core behavior
- Be concise and direct. Prefer short Slack-native messages over long explanations.
- Use Slack-compatible formatting: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, and <url|link text>.
- Don't add filler. Start with the answer or the next action.
- If the user's request is ambiguous, ask 1-2 clarifying questions instead of guessing.

## Answering questions about Kilo Bot
- When users ask what you can do, how you work, or for general help, include a link to the Slackbot documentation: <https://kilo.ai/docs/advanced-usage/slackbot|Kilo Bot docs>
- Provide the docs link along with your answer so users can learn more.

## Context you may receive
Additional context may be appended to this prompt:
- Slack conversation context (recent messages, thread context)
- Available GitHub repositories for this Slack integration
- Available GitLab projects for this Slack integration

Treat this context as authoritative. Prefer selecting a repo from the provided repository list. If the user requests work on a repo that isn't in the list, ask them to confirm the exact owner/repo (or group/project for GitLab) and ensure it's accessible to the integration. Never invent repository names.

## Tool: spawn_cloud_agent
You can call the tool "spawn_cloud_agent" to run a Cloud Agent session for coding work on a GitHub repository or GitLab project.

### When to use it
Use spawn_cloud_agent when the user asks you to:
- change code, fix bugs, implement features, or refactor
- review/analyze code in a repo beyond a quick, high-level answer
- do any task where you must inspect files, run tests, or open a PR/MR

If the user is only asking a question you can answer directly (conceptual, small snippet, explanation), do not call the tool.

### How to use it
Provide exactly ONE of:
- githubRepo: "owner/repo" — for GitHub repositories
- gitlabProject: "group/project" or "group/subgroup/project" — for GitLab projects

Determine which platform to use based on the repository context provided below. If the user mentions a repo that appears in the GitHub list, use githubRepo. If it appears in the GitLab list, use gitlabProject.

Also provide:
- mode:
  - code: implement changes
  - debug: investigate failures, flaky tests, production issues
  - architect: design/plan/spec
  - ask: questions/explanations about existing code
  - orchestrator: multi-repo or multi-step coordination
- prompt: a clear, specific task with constraints and success criteria

Your prompt to the agent should usually include:
- the desired outcome (what "done" looks like)
- any constraints (keep changes minimal, follow existing patterns, etc.)
- a request to open a PR (GitHub) or MR (GitLab) and return the URL

## Accuracy & safety
- Don't claim you ran tools, changed code, or created a PR/MR unless the tool results confirm it.
- Don't fabricate links (including PR/MR URLs).
- If you can't proceed (missing repo, missing details, permissions), say what's missing and what you need next.`;

/**
 * Tool definition for spawning Cloud Agent sessions
 */
const SPAWN_CLOUD_AGENT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'spawn_cloud_agent',
    description:
      'Spawn a Cloud Agent session to perform coding tasks on a GitHub repository or GitLab project. Provide exactly one of githubRepo or gitlabProject.',
    parameters: {
      type: 'object',
      properties: {
        githubRepo: {
          type: 'string',
          description: 'The GitHub repository in owner/repo format (e.g., "facebook/react")',
          pattern: '^[-a-zA-Z0-9_.]+/[-a-zA-Z0-9_.]+$',
        },
        gitlabProject: {
          type: 'string',
          description:
            'The GitLab project path in group/project format (e.g., "mygroup/myproject"). May include nested groups (e.g., "group/subgroup/project").',
          pattern: '^[-a-zA-Z0-9_.]+(/[-a-zA-Z0-9_.]+)+$',
        },
        prompt: {
          type: 'string',
          description:
            'The task description for the Cloud Agent. Be specific about what changes or analysis you want.',
        },
        mode: {
          type: 'string',
          enum: ['architect', 'code', 'ask', 'debug', 'orchestrator'],
          description:
            'The agent mode: "code" for making changes, "architect" for design tasks, "ask" for questions, "debug" for troubleshooting, "orchestrator" for complex multi-step tasks',
          default: 'code',
        },
      },
      required: ['prompt'],
    },
  },
};

/**
 * Result from spawning a Cloud Agent session
 */
type SpawnCloudAgentResult = {
  response: string;
  sessionId?: string;
};

/**
 * Information about the Slack user who requested the PR
 */
type SlackRequesterInfo = {
  displayName: string;
  messagePermalink?: string;
};

/**
 * Build the PR signature to append to the Cloud Agent prompt
 */
function buildPrSignature(requesterInfo: SlackRequesterInfo): string {
  const requesterPart = requesterInfo.messagePermalink
    ? `[${requesterInfo.displayName}](${requesterInfo.messagePermalink})`
    : requesterInfo.displayName;

  return `

---
**PR Signature to include in the PR description:**
When you create a pull request, include the following signature at the end of the PR description:

Built for ${requesterPart} by [Kilo for Slack](https://kilo.ai/features/slack-integration)`;
}

/**
 * Fetch the requester info for PR signatures
 * Gets the user's display name and a permalink to the triggering message
 */
async function getSlackRequesterInfo(
  installation: PlatformIntegration,
  slackEventContext: SlackEventContext
): Promise<SlackRequesterInfo | undefined> {
  const accessToken = getAccessTokenFromInstallation(installation);
  if (!accessToken) {
    console.log('[SlackBot] No access token for requester info');
    return undefined;
  }

  const slackClient = new WebClient(accessToken);

  // Get user display name
  const userInfo = await getSlackUserDisplayAndRealName(slackClient, slackEventContext.userId);
  if (!userInfo) {
    console.log('[SlackBot] Could not get user display name');
    return undefined;
  }

  // Get message permalink
  const permalink = await getSlackMessagePermalink(
    slackClient,
    slackEventContext.channelId,
    slackEventContext.messageTs
  );

  console.log(
    '[SlackBot] Got requester info - displayName:',
    userInfo.displayName,
    'permalink:',
    permalink ? 'yes' : 'no'
  );

  return {
    displayName: userInfo.displayName,
    messagePermalink: permalink,
  };
}

/**
 * Spawn a Cloud Agent session and collect the results.
 * Supports both GitHub (githubRepo) and GitLab (gitlabProject) repositories.
 * Delegates to the shared runSessionToCompletion helper.
 */
async function spawnCloudAgentSession(
  args: {
    githubRepo?: string;
    gitlabProject?: string;
    prompt: string;
    mode?: string;
  },
  owner: Owner,
  model: string,
  authToken: string,
  ticketUserId: string,
  requesterInfo?: SlackRequesterInfo
): Promise<SpawnCloudAgentResult> {
  console.log('[SlackBot] spawnCloudAgentSession called with args:', JSON.stringify(args, null, 2));
  console.log('[SlackBot] Owner:', JSON.stringify(owner, null, 2));

  if (args.githubRepo && args.gitlabProject) {
    return {
      response: 'Error: Both githubRepo and gitlabProject were specified. Provide exactly one.',
    };
  }

  if (!args.githubRepo && !args.gitlabProject) {
    return {
      response: 'Error: No repository specified. Provide either githubRepo or gitlabProject.',
    };
  }

  // Validate the repo identifier has at least "owner/repo" shape (non-empty segments around a slash)
  const repoIdentifier = args.githubRepo ?? args.gitlabProject;
  if (!repoIdentifier || !/\/./.test(repoIdentifier)) {
    return {
      response: `Error: Invalid repository identifier "${repoIdentifier ?? ''}". Expected format like "owner/repo".`,
    };
  }

  let kilocodeOrganizationId: string | undefined;
  if (owner.type === 'org') {
    kilocodeOrganizationId = owner.id;
  }

  // Append PR/MR signature to the prompt if we have requester info
  const promptWithSignature = requesterInfo
    ? args.prompt + buildPrSignature(requesterInfo)
    : args.prompt;

  // Build platform-specific prepareInput and initiateInput
  let prepareInput: PrepareSessionInput;
  let initiateInput: { kilocodeOrganizationId?: string };

  if (args.gitlabProject) {
    // GitLab path: get token + instance URL, build clone URL, use gitUrl/gitToken
    const gitlabToken =
      owner.type === 'org'
        ? await getGitLabTokenForOrganization(owner.id)
        : await getGitLabTokenForUser(owner.id);

    if (!gitlabToken) {
      return {
        response:
          'Error: No GitLab token available. Please ensure a GitLab integration is connected in your Kilo Code settings.',
      };
    }

    const instanceUrl =
      owner.type === 'org'
        ? await getGitLabInstanceUrlForOrganization(owner.id)
        : await getGitLabInstanceUrlForUser(owner.id);

    const gitUrl = buildGitLabCloneUrl(args.gitlabProject, instanceUrl);

    const isSelfHosted = !/^https?:\/\/(www\.)?gitlab\.com(\/|$)/i.test(instanceUrl);
    console.log(
      '[SlackBot] GitLab session - project:',
      args.gitlabProject,
      'instance:',
      isSelfHosted ? 'self-hosted' : 'gitlab.com'
    );

    prepareInput = {
      prompt: promptWithSignature,
      mode: (args.mode as PrepareSessionInput['mode']) || 'code',
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
      owner.type === 'org'
        ? await getGitHubTokenForOrganization(owner.id)
        : await getGitHubTokenForUser(owner.id);

    if (!githubToken) {
      return {
        response:
          'Error: No GitHub token available. Please ensure a GitHub integration is connected in your Kilo Code settings.',
      };
    }

    prepareInput = {
      githubRepo: args.githubRepo,
      prompt: promptWithSignature,
      mode: (args.mode as PrepareSessionInput['mode']) || 'code',
      model,
      githubToken,
      kilocodeOrganizationId,
      createdOnPlatform: 'slack',
    };
    initiateInput = { kilocodeOrganizationId };
  }

  const result = await runSessionToCompletion({
    client: createCloudAgentNextClient(authToken, { skipBalanceCheck: true }),
    prepareInput,
    initiateInput,
    ticketPayload: {
      userId: ticketUserId,
      organizationId: owner.type === 'org' ? owner.id : undefined,
    },
    logPrefix: '[SlackBot]',
  });

  return { response: result.response, sessionId: result.sessionId };
}

/**
 * Process a Kilo Bot message and return the response with metadata.
 * This is the main entry point for generating AI responses with tool support.
 * @param userMessage The message from the user
 * @param teamId The Slack team ID to identify which integration to use
 */
export async function processKiloBotMessage(
  userMessage: string,
  teamId: string,
  slackEventContext?: SlackEventContext
): Promise<KiloBotMessageResult> {
  console.log('[SlackBot] processKiloBotMessage started with message:', userMessage);
  console.log('[SlackBot] Looking up Slack integration for team:', teamId);

  // Track metadata for logging
  let cloudAgentSessionId: string | undefined;

  // Look up the Slack integration to find the owner
  const installation = await getInstallationByTeamId(teamId);
  if (!installation) {
    console.error('[SlackBot] No Slack installation found for team:', teamId);
    return {
      response:
        'Error: No Slack integration found for this workspace. Please install the Kilo Code Slack integration.',
      modelUsed: '',
      toolCallsMade: [],
      error: 'No Slack installation found',
      installation: null,
    };
  }

  const owner = getOwnerFromInstallation(installation);
  if (!owner) {
    console.error('[SlackBot] Could not determine owner from installation:', installation.id);
    return {
      response: 'Error: Could not determine the owner of this Slack integration.',
      modelUsed: '',
      toolCallsMade: [],
      error: 'Could not determine owner',
      installation,
    };
  }

  console.log('[SlackBot] Found owner:', JSON.stringify(owner, null, 2));

  // Get the configured model for this integration (validated at setup/update time)
  const selectedModel = await getModel(owner);
  if (!selectedModel) {
    console.error('[SlackBot] No model configured for owner:', owner);
    return {
      response:
        'Error: No AI model is configured for this Slack integration. Please configure a model in the integration settings.',
      modelUsed: '',
      toolCallsMade: [],
      error: 'No model configured',
      installation,
    };
  }
  console.log('[SlackBot] Using model:', selectedModel);
  console.log(
    '[SlackBot] Looking up Slack user email for auth token generation',
    slackEventContext?.userId
  );

  // Get the Slack user's email for auth token generation
  const slackUserEmail = slackEventContext?.userId
    ? await getSlackUserEmailFromInstallation(installation, slackEventContext.userId)
    : undefined;

  // For organization-owned integrations, use bot user for auth token
  // This ensures usage is tracked at the organization level, not individual users
  const authResult = await getSlackbotAuthTokenForOwner(owner, slackUserEmail);
  if ('error' in authResult) {
    return {
      response: `Error: ${authResult.error}`,
      modelUsed: '',
      toolCallsMade: [],
      error: authResult.error,
      installation,
    };
  }
  const authToken = authResult.authToken;
  const authUserId = authResult.userId;

  let slackContextForPrompt = '';
  if (slackEventContext) {
    const slackConversationContext = await getSlackConversationContext(teamId, slackEventContext);
    slackContextForPrompt = await formatSlackConversationContextForPrompt(
      teamId,
      slackConversationContext,
      slackEventContext
    );
  }

  // Get requester info for PR signatures (user name + message permalink)
  const slackRequesterInfo = slackEventContext
    ? await getSlackRequesterInfo(installation, slackEventContext)
    : undefined;

  // Get repository context (no extra requests; uses the same integration rows)
  const githubRepoContext = await getGitHubRepositoryContext(owner);
  const gitlabRepoContext = await getGitLabRepositoryContext(owner);
  const githubRepoCount = githubRepoContext.repositories
    ? githubRepoContext.repositories.length
    : 0;
  const gitlabRepoCount = gitlabRepoContext.repositories
    ? gitlabRepoContext.repositories.length
    : 0;
  console.log(
    '[SlackBot] Found',
    githubRepoCount,
    'GitHub and',
    gitlabRepoCount,
    'GitLab repositories'
  );

  // Build system prompt with Slack context + repository context for both platforms
  const systemPrompt =
    KILO_BOT_SYSTEM_PROMPT +
    slackContextForPrompt +
    formatGitHubRepositoriesForPrompt(githubRepoContext) +
    formatGitLabRepositoriesForPrompt(gitlabRepoContext);

  const runResult = await runBot({
    authToken,
    model: selectedModel,
    systemPrompt,
    userMessage,
    tools: [SPAWN_CLOUD_AGENT_TOOL],
    logPrefix: '[SlackBot]',
    requestOptions: {
      version: SLACK_BOT_VERSION,
      userAgent: SLACK_BOT_USER_AGENT,
      organizationId: owner.type === 'org' ? owner.id : undefined,
      feature: 'slack',
    },
    toolExecutor: async toolCall => {
      if (toolCall.type !== 'function') {
        console.log('[SlackBot] Skipping non-function tool call');
        return { content: 'Skipped non-function tool call.' };
      }

      if (toolCall.function.name !== 'spawn_cloud_agent') {
        console.log('[SlackBot] Unknown tool:', toolCall.function.name);
        return { content: `Error executing tool: Unknown tool ${toolCall.function.name}` };
      }

      console.log(
        '[SlackBot] spawn_cloud_agent tool call - arguments:',
        toolCall.function.arguments
      );
      const args = JSON.parse(toolCall.function.arguments);
      console.log('[SlackBot] Parsed tool arguments:', JSON.stringify(args, null, 2));

      console.log('[SlackBot] Calling spawnCloudAgentSession...');
      const toolResult = await spawnCloudAgentSession(
        args,
        owner,
        selectedModel,
        authToken,
        authUserId,
        slackRequesterInfo
      );
      console.log('[SlackBot] Tool result received, length:', toolResult.response.length);
      console.log('[SlackBot] Tool result preview:', toolResult.response.slice(0, 100));
      if (toolResult.sessionId) {
        cloudAgentSessionId = toolResult.sessionId;
      }

      return {
        content: toolResult.response,
        metadata: toolResult.sessionId ? { cloudAgentSessionId: toolResult.sessionId } : undefined,
      };
    },
  });

  return {
    response: runResult.response,
    modelUsed: selectedModel,
    toolCallsMade: runResult.toolCallsMade,
    cloudAgentSessionId,
    error: runResult.error,
    installation,
  };
}

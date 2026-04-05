import 'server-only';
import {
  createCloudAgentNextClient,
  type PrepareSessionInput,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { runSessionToCompletion } from '@/lib/cloud-agent-next/run-session';
import {
  getGitHubTokenForUser,
  getGitHubTokenForOrganization,
} from '@/lib/cloud-agent/github-integration-helpers';
import type OpenAI from 'openai';
import type { Owner } from '@/lib/integrations/core/types';
import {
  getInstallationByGuildId,
  getOwnerFromInstallation,
  getModel,
} from '@/lib/integrations/discord-service';
import { runBot } from '@/lib/bots/core/run-bot';
import {
  formatGitHubRepositoriesForPrompt,
  getGitHubRepositoryContext,
} from '@/lib/slack-bot/github-repository-context';
import {
  formatDiscordConversationContextForPrompt,
  getDiscordConversationContext,
  type DiscordEventContext,
} from '@/lib/discord-bot/discord-channel-context';
import { getDiscordBotAuthTokenForOwner } from '@/lib/discord/auth';
import { buildDiscordMessageLink } from '@/lib/discord-bot/discord-utils';
import type { PlatformIntegration } from '@kilocode/db';

// Version string for API requests
const DISCORD_BOT_VERSION = '5.0.0';
const DISCORD_BOT_USER_AGENT = `Kilo-Code-Discord/${DISCORD_BOT_VERSION}`;

/**
 * Result from processing a Discord bot message
 */
export type DiscordBotMessageResult = {
  response: string;
  modelUsed: string;
  toolCallsMade: string[];
  cloudAgentSessionId?: string;
  error?: string;
  installation: PlatformIntegration | null;
};

const KILO_BOT_SYSTEM_PROMPT = `You are Kilo Bot, a helpful AI assistant integrated into Discord.

## Core behavior
- Be concise and direct. Prefer short messages over long explanations.
- Use Discord-compatible markdown: **bold**, *italic*, \`code\`, \`\`\`code blocks\`\`\`, and [link text](url).
- Don't add filler. Start with the answer or the next action.
- If the user's request is ambiguous, ask 1-2 clarifying questions instead of guessing.
- Discord has a 2000 character message limit. Keep responses concise.

## Answering questions about Kilo Bot
- When users ask what you can do, how you work, or for general help, include a link to the documentation: [Kilo Bot docs](https://kilo.ai/docs)
- Provide the docs link along with your answer so users can learn more.

## Context you may receive
Additional context may be appended to this prompt:
- Discord conversation context (recent messages)
- Available GitHub repositories for this Discord integration

Treat this context as authoritative. Prefer selecting a repo from the provided repository list. If the user requests work on a repo that isn't in the list, ask them to confirm the exact owner/repo and ensure it's accessible to the integration. Never invent repository names.

## Tool: spawn_cloud_agent
You can call the tool "spawn_cloud_agent" to run a Cloud Agent session for coding work on a GitHub repository.

### When to use it
Use spawn_cloud_agent when the user asks you to:
- change code, fix bugs, implement features, or refactor
- review/analyze code in a repo beyond a quick, high-level answer
- do any task where you must inspect files, run tests, or open a PR

If the user is only asking a question you can answer directly (conceptual, small snippet, explanation), do not call the tool.

### How to use it
Provide:
- githubRepo: "owner/repo"
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
- a request to open a PR and return the PR URL

## Accuracy & safety
- Don't claim you ran tools, changed code, or created a PR unless the tool results confirm it.
- Don't fabricate links (including PR URLs).
- If you can't proceed (missing repo, missing details, permissions), say what's missing and what you need next.`;

/**
 * Tool definition for spawning Cloud Agent sessions
 */
const SPAWN_CLOUD_AGENT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'spawn_cloud_agent',
    description:
      'Spawn a Cloud Agent session to perform coding tasks on a GitHub repository. The agent can make code changes, fix bugs, implement features, and more.',
    parameters: {
      type: 'object',
      properties: {
        githubRepo: {
          type: 'string',
          description: 'The GitHub repository in owner/repo format (e.g., "facebook/react")',
          pattern: '^[-a-zA-Z0-9_.]+/[-a-zA-Z0-9_.]+$',
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
      required: ['githubRepo', 'prompt'],
    },
  },
};

type DiscordRequesterInfo = {
  displayName: string;
  messageLink?: string;
};

function buildPrSignature(requesterInfo: DiscordRequesterInfo): string {
  const requesterPart = requesterInfo.messageLink
    ? `[${requesterInfo.displayName}](${requesterInfo.messageLink})`
    : requesterInfo.displayName;

  return `

---
**PR Signature to include in the PR description:**
When you create a pull request, include the following signature at the end of the PR description:

Built for ${requesterPart} by [Kilo for Discord](https://kilo.ai)`;
}

/**
 * Spawn a Cloud Agent session
 */
async function spawnCloudAgentSession(
  args: { githubRepo: string; prompt: string; mode?: string },
  owner: Owner,
  model: string,
  authToken: string,
  ticketUserId: string,
  requesterInfo?: DiscordRequesterInfo
): Promise<{ response: string; sessionId?: string }> {
  console.log(
    '[DiscordBot] spawnCloudAgentSession called with args:',
    JSON.stringify(args, null, 2)
  );
  console.log('[DiscordBot] Owner:', JSON.stringify(owner, null, 2));

  let githubToken: string | undefined;
  let kilocodeOrganizationId: string | undefined;

  if (owner.type === 'org') {
    githubToken = await getGitHubTokenForOrganization(owner.id);
    kilocodeOrganizationId = owner.id;
  } else {
    githubToken = await getGitHubTokenForUser(owner.id);
  }

  const promptWithSignature = requesterInfo
    ? args.prompt + buildPrSignature(requesterInfo)
    : args.prompt;

  const result = await runSessionToCompletion({
    client: createCloudAgentNextClient(authToken, { skipBalanceCheck: true }),
    prepareInput: {
      githubRepo: args.githubRepo,
      prompt: promptWithSignature,
      mode: (args.mode as PrepareSessionInput['mode']) || 'code',
      model,
      githubToken,
      kilocodeOrganizationId,
      createdOnPlatform: 'discord',
    },
    initiateInput: {
      kilocodeOrganizationId,
    },
    ticketPayload: {
      userId: ticketUserId,
      organizationId: owner.type === 'org' ? owner.id : undefined,
    },
    logPrefix: '[DiscordBot]',
  });

  return { response: result.response, sessionId: result.sessionId };
}

/**
 * Process a Discord bot message and return the response with metadata.
 * Main entry point for generating AI responses.
 */
export async function processDiscordBotMessage(
  userMessage: string,
  guildId: string,
  discordEventContext?: DiscordEventContext
): Promise<DiscordBotMessageResult> {
  console.log('[DiscordBot] processDiscordBotMessage started');

  let cloudAgentSessionId: string | undefined;

  const installation = await getInstallationByGuildId(guildId);
  if (!installation) {
    return {
      response:
        'Error: No Discord integration found for this server. Please install the Kilo Code Discord integration.',
      modelUsed: '',
      toolCallsMade: [],
      error: 'No Discord installation found',
      installation: null,
    };
  }

  const owner = getOwnerFromInstallation(installation);
  if (!owner) {
    return {
      response: 'Error: Could not determine the owner of this Discord integration.',
      modelUsed: '',
      toolCallsMade: [],
      error: 'Could not determine owner',
      installation,
    };
  }

  // Get the configured model for this integration (validated at setup/update time)
  const selectedModel = await getModel(owner);
  if (!selectedModel) {
    console.error('[DiscordBot] No model configured for owner:', owner);
    return {
      response:
        'Error: No AI model is configured for this Discord integration. Please configure a model in the integration settings.',
      modelUsed: '',
      toolCallsMade: [],
      error: 'No model configured',
      installation,
    };
  }
  console.log('[DiscordBot] Using model:', selectedModel);

  const authResult = await getDiscordBotAuthTokenForOwner(owner);
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

  // Gather context in parallel
  let discordContextForPrompt = '';
  let requesterInfo: DiscordRequesterInfo | undefined;

  if (discordEventContext) {
    const conversationContext = await getDiscordConversationContext(discordEventContext);
    discordContextForPrompt = formatDiscordConversationContextForPrompt(
      conversationContext,
      discordEventContext
    );

    // Build requester info for PR signatures
    requesterInfo = {
      displayName: `Discord user <@${discordEventContext.userId}>`,
      messageLink: buildDiscordMessageLink(
        discordEventContext.guildId,
        discordEventContext.channelId,
        discordEventContext.messageId
      ),
    };
  }

  const repoContext = await getGitHubRepositoryContext(owner);

  const systemPrompt =
    KILO_BOT_SYSTEM_PROMPT +
    discordContextForPrompt +
    formatGitHubRepositoriesForPrompt(repoContext);

  const runResult = await runBot({
    authToken,
    model: selectedModel,
    systemPrompt,
    userMessage,
    tools: [SPAWN_CLOUD_AGENT_TOOL],
    logPrefix: '[DiscordBot]',
    requestOptions: {
      version: DISCORD_BOT_VERSION,
      userAgent: DISCORD_BOT_USER_AGENT,
      organizationId: owner.type === 'org' ? owner.id : undefined,
      feature: 'discord',
    },
    toolExecutor: async toolCall => {
      if (toolCall.type !== 'function') {
        return { content: 'Skipped non-function tool call.' };
      }

      if (toolCall.function.name !== 'spawn_cloud_agent') {
        return { content: `Error executing tool: Unknown tool ${toolCall.function.name}` };
      }

      const args = JSON.parse(toolCall.function.arguments);
      const toolResult = await spawnCloudAgentSession(
        args,
        owner,
        selectedModel,
        authToken,
        authUserId,
        requesterInfo
      );

      if (toolResult.sessionId) {
        cloudAgentSessionId = toolResult.sessionId;
      }

      return { content: toolResult.response };
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

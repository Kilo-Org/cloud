import type OpenAI from 'openai';
import { getToolDefinitionsForOwner, getTool, type ToolExecutionContext } from '@/lib/bot/tools';
import {
  getInstallationByTeamId,
  getOwnerFromInstallation,
  getModel,
  getAccessTokenFromInstallation,
} from '@/lib/integrations/slack-service';
import type { PlatformIntegration } from '@/db/schema';
import { sendProxiedChatCompletion } from '@/lib/llm-proxy-helpers';
import {
  formatGitHubRepositoriesForPrompt,
  getGitHubRepositoryContext,
} from '@/lib/slack-bot/github-repository-context';
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

Treat this context as authoritative. Prefer selecting a repo from the provided repository list. If the user requests work on a repo that isn’t in the list, ask them to confirm the exact owner/repo and ensure it’s accessible to the integration. Never invent repository names.

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
- the desired outcome (what “done” looks like)
- any constraints (keep changes minimal, follow existing patterns, etc.)
- a request to open a PR and return the PR URL

## Accuracy & safety
- Don’t claim you ran tools, changed code, or created a PR unless the tool results confirm it.
- Don’t fabricate links (including PR URLs).
- If you can’t proceed (missing repo, missing details, permissions), say what’s missing and what you need next.`;

/**
 * Information about the Slack user who requested the PR
 */
type SlackRequesterInfo = {
  displayName: string;
  messagePermalink?: string;
};

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

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionResponse = OpenAI.Chat.Completions.ChatCompletion;

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
  const toolCallsMade: string[] = [];
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
  if (!authResult.authToken) {
    return {
      response: `Error: ${authResult.error}`,
      modelUsed: '',
      toolCallsMade: [],
      error: authResult.error,
      installation,
    };
  }
  const authToken = authResult.authToken;

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

  // Get repository context (no extra requests; uses the same integration row)
  const repoContext = await getGitHubRepositoryContext(owner);
  const repoCount = repoContext.repositories ? repoContext.repositories.length : 0;
  console.log('[SlackBot] Found', repoCount, 'available repositories');

  // Build system prompt with Slack context + repository context
  const systemPrompt =
    KILO_BOT_SYSTEM_PROMPT + slackContextForPrompt + formatGitHubRepositoriesForPrompt(repoContext);

  // Get available tools for this owner (based on their integrations)
  const availableToolDefinitions = await getToolDefinitionsForOwner(owner);
  console.log('[SlackBot] Available tools:', availableToolDefinitions.length);

  // Build tool execution context for later use
  const toolExecutionContext: ToolExecutionContext = {
    owner,
    authToken,
    model: selectedModel,
    requesterInfo: slackRequesterInfo,
  };

  // Build initial messages array
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: userMessage,
    },
  ];

  // Tool calling loop - keep calling until we get a final response
  let finalResponse: string | null = null;
  let errorMessage: string | undefined;
  const maxIterations = 5; // Prevent infinite loops
  let iteration = 0;

  while (finalResponse === null && iteration < maxIterations) {
    iteration++;
    console.log(`[SlackBot] Tool loop iteration ${iteration}/${maxIterations}`);

    console.log('[SlackBot] Sending request to chat completions endpoint...');
    const result = await sendProxiedChatCompletion<ChatCompletionResponse>({
      authToken,
      version: SLACK_BOT_VERSION,
      userAgent: SLACK_BOT_USER_AGENT,
      body: {
        model: selectedModel,
        messages,
        tools: availableToolDefinitions.length > 0 ? availableToolDefinitions : undefined,
        tool_choice: availableToolDefinitions.length > 0 ? 'auto' : undefined,
      },
      organizationId: owner.type === 'org' ? owner.id : undefined,
    });

    if (!result.ok) {
      console.error('[SlackBot] API error response:', result.error);
      finalResponse = `Sorry, there was an error calling the AI service (${result.status}): ${result.error.slice(0, 200)}`;
      break;
    }

    const responseBody = result.data;
    console.log('[SlackBot] Response body parsed, choices count:', responseBody.choices?.length);
    const choice = responseBody.choices?.[0];

    if (!choice) {
      console.log('[SlackBot] No choice in response, response body:', JSON.stringify(responseBody));
      finalResponse = 'Sorry, I could not generate a response.';
      errorMessage = 'No choice in OpenRouter response';
      break;
    }

    const message = choice.message;
    console.log(
      '[SlackBot] Message received - content length:',
      message.content?.length,
      'tool_calls:',
      message.tool_calls?.length || 0
    );
    console.log('[SlackBot] Message content preview:', message.content?.slice(0, 200));

    // Check if the assistant wants to call a tool
    if (message.tool_calls && message.tool_calls.length > 0) {
      console.log('[SlackBot] Tool calls detected:', message.tool_calls.length);

      // Add assistant message to conversation history
      messages.push({
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls,
      });
      console.log(
        '[SlackBot] Added assistant message to history, total messages:',
        messages.length
      );

      // Process each tool call
      for (const toolCall of message.tool_calls) {
        console.log(
          '[SlackBot] Processing tool call:',
          toolCall.type,
          toolCall.type === 'function' ? toolCall.function.name : 'N/A'
        );

        // Skip non-function tool calls
        if (toolCall.type !== 'function') {
          console.log('[SlackBot] Skipping non-function tool call');
          continue;
        }

        const toolName = toolCall.function.name;
        toolCallsMade.push(toolName);

        // Look up the tool in the registry
        const tool = getTool(toolName);
        if (!tool) {
          console.log('[SlackBot] Unknown tool:', toolName);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error: Unknown tool "${toolName}"`,
          });
          continue;
        }

        console.log(
          '[SlackBot] Executing tool:',
          toolName,
          'arguments:',
          toolCall.function.arguments
        );

        try {
          const args = JSON.parse(toolCall.function.arguments);
          console.log('[SlackBot] Parsed tool arguments:', JSON.stringify(args, null, 2));

          const toolResult = await tool.execute(args, toolExecutionContext);
          console.log('[SlackBot] Tool result received, length:', toolResult.response.length);
          console.log('[SlackBot] Tool result preview:', toolResult.response.slice(0, 100));

          // Track cloud agent session ID if present in metadata
          if (toolResult.metadata?.sessionId) {
            cloudAgentSessionId = toolResult.metadata.sessionId as string;
          }

          // Add tool result to conversation history
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.response,
          });
          console.log('[SlackBot] Added tool result to history, total messages:', messages.length);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error('[SlackBot] Error executing tool:', errMsg, error);
          errorMessage = errMsg;
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error executing tool: ${errMsg}`,
          });
        }
      }
    } else {
      // No tool calls - we have the final response
      console.log('[SlackBot] No tool calls, setting final response');
      finalResponse = message.content ?? 'Sorry, I could not generate a response.';
    }
  }

  if (finalResponse === null) {
    console.log('[SlackBot] Max iterations reached, setting timeout message');
    finalResponse = 'Sorry, the request took too long to process.';
    errorMessage = 'Max iterations reached';
  }

  console.log('[SlackBot] Final response length:', finalResponse.length);
  console.log('[SlackBot] Final response preview:', finalResponse.slice(0, 500));

  return {
    response: finalResponse,
    modelUsed: selectedModel,
    toolCallsMade,
    cloudAgentSessionId,
    error: errorMessage,
    installation,
  };
}

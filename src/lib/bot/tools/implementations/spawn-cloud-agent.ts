import {
  createCloudAgentClient,
  type InitiateSessionInput,
} from '@/lib/cloud-agent/cloud-agent-client';
import {
  getGitHubTokenForUser,
  getGitHubTokenForOrganization,
} from '@/lib/cloud-agent/github-integration-helpers';
import type { BotTool, ToolExecutionContext, ToolResult, RequesterInfo } from '../types';

/**
 * Arguments for the spawn_cloud_agent tool
 */
type SpawnCloudAgentArgs = {
  githubRepo: string;
  prompt: string;
  mode?: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
};

/**
 * Build the PR signature to append to the Cloud Agent prompt.
 * This adds attribution for who requested the PR.
 */
function buildPrSignature(requesterInfo: RequesterInfo): string {
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
 * Execute the spawn_cloud_agent tool.
 * Spawns a Cloud Agent session and streams the results.
 */
async function executeSpawnCloudAgent(
  args: SpawnCloudAgentArgs,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { owner, authToken, model, requesterInfo } = context;

  console.log('[SpawnCloudAgent] Called with args:', JSON.stringify(args, null, 2));
  console.log('[SpawnCloudAgent] Owner:', JSON.stringify(owner, null, 2));

  let githubToken: string | undefined;
  let kilocodeOrganizationId: string | undefined;

  // Handle organization-owned integrations
  if (owner.type === 'org') {
    // Get GitHub token for the organization
    githubToken = await getGitHubTokenForOrganization(owner.id);
    // Set the organization ID for cloud agent usage attribution
    kilocodeOrganizationId = owner.id;
  } else {
    // Get GitHub token for the user
    githubToken = await getGitHubTokenForUser(owner.id);
  }

  // Skip balance check for bot users - bot integration has its own billing model
  const cloudAgentClient = createCloudAgentClient(authToken, { skipBalanceCheck: true });

  // Append PR signature to the prompt if we have requester info
  const promptWithSignature = requesterInfo
    ? args.prompt + buildPrSignature(requesterInfo)
    : args.prompt;

  const input: InitiateSessionInput = {
    githubRepo: args.githubRepo,
    prompt: promptWithSignature,
    mode: args.mode || 'code',
    model: model,
    githubToken,
    kilocodeOrganizationId,
    createdOnPlatform: 'slack',
  };

  const statusMessages: string[] = [];
  let completionResult: string | undefined;
  let sessionId: string | undefined;
  let hasError = false;

  try {
    console.log('[SpawnCloudAgent] Starting to stream events from Cloud Agent...');
    for await (const event of cloudAgentClient.initiateSessionStream(input)) {
      if (event.sessionId) sessionId = event.sessionId;

      switch (event.streamEventType) {
        case 'complete':
          statusMessages.push(
            `Session completed in ${event.metadata.executionTimeMs}ms with exit code ${event.exitCode}`
          );
          break;
        case 'error':
          statusMessages.push(`Error: ${event.error}`);
          hasError = true;
          break;
        case 'kilocode': {
          const payload = event.payload;
          if (payload.say === 'completion_result' && typeof payload.content === 'string') {
            completionResult = payload.content;
          }
          break;
        }
        case 'output':
          if (event.source === 'stderr') {
            statusMessages.push(`[stderr] ${event.content}`);
            hasError = true;
            console.log('[SpawnCloudAgent] Error flag set to true');
          }
          break;
        case 'interrupted':
          statusMessages.push(`Session interrupted: ${event.reason}`);
          hasError = true;
          console.log('[SpawnCloudAgent] Error flag set to true');
          break;
      }
    }
    console.log(
      `[SpawnCloudAgent] Stream completed. Total status messages: ${statusMessages.length}, Has completion result: ${!!completionResult}`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SpawnCloudAgent] Error during stream:', errorMessage, error);
    return {
      success: false,
      response: `Error spawning Cloud Agent: ${errorMessage}`,
      metadata: { sessionId },
    };
  }

  if (hasError) {
    const errorResult = `Cloud Agent session ${sessionId || 'unknown'} encountered errors:\n${statusMessages.join('\n')}`;
    console.log('[SpawnCloudAgent] Returning error result:', errorResult);
    return {
      success: false,
      response: errorResult,
      metadata: { sessionId },
    };
  }

  // Return the completion result if available, otherwise show status messages
  if (completionResult) {
    const successResult = `Cloud Agent session ${sessionId || 'unknown'} completed:\n\n${completionResult}`;
    console.log('[SpawnCloudAgent] Returning success result');
    return {
      success: true,
      response: successResult,
      metadata: { sessionId },
    };
  }

  const fallbackResult = `Cloud Agent session ${sessionId || 'unknown'} completed successfully.\n\nStatus:\n${statusMessages.slice(-5).join('\n')}`;
  console.log('[SpawnCloudAgent] Returning fallback result:', fallbackResult);
  return {
    success: true,
    response: fallbackResult,
    metadata: { sessionId },
  };
}

/**
 * The spawn_cloud_agent tool definition.
 * This tool spawns a Cloud Agent session to perform coding tasks on a GitHub repository.
 */
export const spawnCloudAgentTool: BotTool = {
  name: 'spawn_cloud_agent',
  requiredIntegration: 'github',

  definition: {
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
  },

  async execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    // Validate and cast args
    const typedArgs = args as SpawnCloudAgentArgs;
    if (!typedArgs.githubRepo || !typedArgs.prompt) {
      return {
        success: false,
        response: 'Missing required arguments: githubRepo and prompt are required',
      };
    }
    return executeSpawnCloudAgent(typedArgs, context);
  },
};

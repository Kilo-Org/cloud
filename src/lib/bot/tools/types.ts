import type OpenAI from 'openai';
import type { Owner } from '@/lib/integrations/core/types';

/**
 * Result returned from executing a tool
 */
export type ToolResult = {
  success: boolean;
  response: string;
  metadata?: Record<string, unknown>;
};

/**
 * Information about the user who triggered the bot request.
 * Used for attribution in PRs and other tool outputs.
 */
export type RequesterInfo = {
  displayName: string;
  messagePermalink?: string;
};

/**
 * Context passed to tool execution.
 * Contains all information a tool needs to perform its action.
 */
export type ToolExecutionContext = {
  /** The owner (user or org) of the integration */
  owner: Owner;
  /** Authentication token for API calls */
  authToken: string;
  /** The AI model being used */
  model: string;
  /** Information about the user who triggered the request */
  requesterInfo?: RequesterInfo;
};

/**
 * A bot tool that can be called by the AI model.
 *
 * Tools are registered at startup and dynamically loaded per-request
 * based on which integrations the owner has enabled.
 */
export type BotTool = {
  /** Unique name of the tool (must match function.name in definition) */
  name: string;

  /**
   * The integration required for this tool to be available.
   * If specified, the tool will only be included when the owner has this integration.
   * Examples: 'github', 'gitlab', 'sentry', 'axiom'
   */
  requiredIntegration?: string;

  /** OpenAI function calling tool definition */
  definition: OpenAI.Chat.Completions.ChatCompletionTool;

  /**
   * Execute the tool with the given arguments.
   * @param args - Parsed arguments from the AI model's tool call
   * @param context - Execution context with owner, auth, and model info
   * @returns Result containing success status and response text
   */
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
};

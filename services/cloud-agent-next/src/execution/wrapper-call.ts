/**
 * Single branch point for the orchestrator's final wrapper call.
 *
 * `sendMessageV2` carries a discriminated payload (`type: 'prompt' | 'command'`)
 * all the way through `StartExecutionV2Request` → `ExecutionPlan`. Everything
 * up to this point — workspace prep, wrapper start, image download, execution
 * binding — is identical for both variants. The only thing that differs is
 * the wrapper API we hit at the end.
 *
 * Keeping this in its own module keeps the orchestrator readable and gives
 * us one place to test the branch.
 */

import type {
  WrapperClient,
  ExecutionBinding,
  WrapperPromptOptions,
  WrapperCommandOptions,
} from '../kilo/wrapper-client.js';
import type { ExecutionPayload } from './types.js';
import { buildImagePromptParts, type ImageFilePart } from './image-prompt-parts.js';

/**
 * Common context every wrapper call needs, grouped to avoid threading 7+ loose
 * args through multiple call sites (per the user's typed-bundle preference).
 */
export type WrapperCallContext = {
  execution: ExecutionBinding;
  /**
   * Mode normalized to a kilo agent slug (e.g. 'plan', 'code'). Used for the
   * prompt path's `agent` override; ignored for command payloads since kilo's
   * `Command.Info.agent` takes precedence.
   */
  normalizedMode: string;
  /** Wrapper plan slice — model, variant, autoCommit, condenseOnComplete. */
  model?: WrapperPromptOptions['model'];
  variant?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  tools?: WrapperPromptOptions['tools'];
  /** Optional message ID for correlating the request. */
  messageId?: string;
  /** Image attachments (prompt path only). */
  fileParts: ImageFilePart[];
};

/**
 * Dispatch the execution to the wrapper based on payload type.
 * - prompt: `wrapperClient.prompt(...)` (existing path)
 * - command: `wrapperClient.command(...)` — slash command invocation
 */
export async function dispatchToWrapper(
  client: WrapperClient,
  ctx: WrapperCallContext,
  payload: ExecutionPayload
): Promise<{ messageId?: string }> {
  if (payload.type === 'command') {
    const options: WrapperCommandOptions = {
      command: payload.command,
      args: payload.arguments,
      messageId: ctx.messageId,
      autoCommit: ctx.autoCommit,
      condenseOnComplete: ctx.condenseOnComplete,
      execution: ctx.execution,
    };
    await client.command(options);
    return {};
  }

  // Prompt payload — preserve the existing options builder behavior.
  const promptOptions: WrapperPromptOptions = {
    messageId: ctx.messageId,
    model: ctx.model,
    variant: ctx.variant,
    agent: ctx.normalizedMode,
    autoCommit: ctx.autoCommit,
    condenseOnComplete: ctx.condenseOnComplete,
    tools: ctx.tools,
    execution: ctx.execution,
  };

  if (ctx.fileParts.length > 0) {
    promptOptions.parts = buildImagePromptParts(payload.prompt, ctx.fileParts);
  } else {
    promptOptions.prompt = payload.prompt;
  }

  return client.prompt(promptOptions);
}

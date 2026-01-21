/**
 * Bot Tools System
 *
 * This module provides a registry and loader for bot tools that can be called
 * by the AI model. Tools are registered at module load time and dynamically
 * loaded per-request based on which integrations the owner has enabled.
 *
 * Usage:
 * ```typescript
 * import { getToolsForOwner, getTool } from '@/lib/bot/tools';
 *
 * // Get tools available to an owner
 * const tools = await getToolsForOwner(owner);
 *
 * // Get tool definitions for OpenAI
 * const definitions = await getToolDefinitionsForOwner(owner);
 *
 * // Look up a specific tool
 * const tool = getTool('spawn_cloud_agent');
 * ```
 */

// Export types
export type { BotTool, ToolResult, ToolExecutionContext, RequesterInfo } from './types';

// Export registry functions
export {
  registerTool,
  getTool,
  getAllTools,
  hasRegisteredTool,
  getRegisteredToolCount,
} from './registry';

// Export loader functions
export { getToolsForOwner, getToolDefinitionsForOwner } from './tool-loader';

// Register all tool implementations
// This runs when the module is first imported
import { registerTool } from './registry';
import { spawnCloudAgentTool } from './implementations/spawn-cloud-agent';

registerTool(spawnCloudAgentTool);

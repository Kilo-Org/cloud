import type OpenAI from 'openai';
import type { Owner } from '@/lib/integrations/core/types';
import { getAllActiveIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { getAllTools } from './registry';
import type { BotTool } from './types';

/**
 * Get the set of active integration platforms for an owner.
 * Used to filter which tools are available for a given owner.
 *
 * @param owner - The owner (user or org) to check integrations for
 * @returns Set of platform names that the owner has active integrations for
 */
async function getActiveIntegrationPlatforms(owner: Owner): Promise<string[]> {
  const integrations = await getAllActiveIntegrationsForOwner(owner);

  return integrations.map(integration => integration.platform);
}

/**
 * Get all tools available to an owner based on their active integrations.
 * Tools with no requiredIntegration are always available.
 * Tools with a requiredIntegration are only available if the owner has that integration.
 *
 * @param owner - The owner (user or org) to get tools for
 * @returns Array of tools available to this owner
 */
export async function getToolsForOwner(owner: Owner): Promise<BotTool[]> {
  const activePlatforms = await getActiveIntegrationPlatforms(owner);
  const allTools = getAllTools();

  const availableTools = allTools.filter(tool => {
    // Tools without a required integration are always available
    if (!tool.requiredIntegration) {
      return true;
    }

    // Tools with a required integration are only available if owner has it
    return activePlatforms.includes(tool.requiredIntegration);
  });

  console.log(
    `[ToolLoader] Owner has ${activePlatforms.length} active integrations, ` +
      `${availableTools.length}/${allTools.length} tools available`
  );

  return availableTools;
}

/**
 * Get OpenAI tool definitions for all tools available to an owner.
 * This is the format expected by the OpenAI Chat Completions API.
 *
 * @param owner - The owner (user or org) to get tool definitions for
 * @returns Array of tool definitions in OpenAI format
 */
export async function getToolDefinitionsForOwner(
  owner: Owner
): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
  const tools = await getToolsForOwner(owner);
  return tools.map(tool => tool.definition);
}

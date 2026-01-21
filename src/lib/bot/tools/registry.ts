import type { BotTool } from './types';

/**
 * Global registry of all available bot tools.
 * Tools are registered at module load time and looked up at runtime.
 */
const toolRegistry = new Map<string, BotTool>();

/**
 * Register a tool in the global registry.
 * Should be called at module initialization time.
 *
 * @param tool - The tool to register
 * @throws Error if a tool with the same name is already registered
 */
export function registerTool(tool: BotTool): void {
  if (toolRegistry.has(tool.name)) {
    throw new Error(`Tool "${tool.name}" is already registered`);
  }
  toolRegistry.set(tool.name, tool);
  console.log(`[ToolRegistry] Registered tool: ${tool.name}`);
}

/**
 * Get a tool by name from the registry.
 *
 * @param name - The name of the tool to retrieve
 * @returns The tool if found, undefined otherwise
 */
export function getTool(name: string): BotTool | undefined {
  return toolRegistry.get(name);
}

/**
 * Get all registered tools.
 *
 * @returns Array of all registered tools
 */
export function getAllTools(): BotTool[] {
  return Array.from(toolRegistry.values());
}

/**
 * Check if a tool is registered.
 *
 * @param name - The name of the tool to check
 * @returns true if the tool is registered
 */
export function hasRegisteredTool(name: string): boolean {
  return toolRegistry.has(name);
}

/**
 * Get the count of registered tools.
 * Useful for debugging and testing.
 *
 * @returns Number of registered tools
 */
export function getRegisteredToolCount(): number {
  return toolRegistry.size;
}
